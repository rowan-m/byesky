import { Agent } from '@atproto/api';
import { initOAuthClient, startBackgroundSync, batchUnfollow, followUser } from './atproto.js';
import { syncCache } from './cache.js';

// Application State
let state = {
  user: null, // { loggedIn: false } or { loggedIn: true, did, handle }
  session: null, // Active OAuthSession object
  agent: null, // ATProto Agent instance
  sync: {
    status: 'idle',
    error: null,
    progress: { total: 0, processed: 0, currentStage: 'Not started' },
    totalCount: 0,
  },
  followings: [], // Raw followings from backend
  selectedDids: new Set(), // DIDs marked for unfollowing
  pagination: {
    currentPage: 1,
    pageSize: 100,
  },
  sorting: {
    col: 'score',
    order: 'desc', // High score (strongest unfollow reason) shown first
  },
  searchQuery: '',
  weights: {
    notFollowing: 1,
    inactive: 4,
    noInbound: 1,
    noOutbound: 5,
    deletedBanned: 4,
    blocking: 4,
    noisy: 1,
    muted: 4,
    massFollower: 1,
    spammyRatio: 1,
    flagged: 3,
    outlier: 1,
  },
  filters: {
    ok: true,
    notFollowing: true,
    inactive: true,
    noInbound: true,
    noOutbound: true,
    deletedBanned: true,
    blocking: true,
    lowFollowers: true,
    noisy: true,
    muted: true,
    massFollower: true,
    spammyRatio: true,
    flagged: true,
    outlier: true,
  },
  params: {
    inactiveDays: 180,
    lowFollowersThreshold: 50,
    noisyPostsThreshold: 20,
    massFollowerThreshold: 3500,
  },
  pendingUnfollowDids: [], // Holds DIDs during confirmation modal
};

// DOM Elements
const authSection = document.getElementById('auth-section');
const syncSection = document.getElementById('sync-section');
const dashboardSection = document.getElementById('dashboard-section');
const loginForm = document.getElementById('login-form');
const loginHandle = document.getElementById('login-handle');
const loginError = document.getElementById('login-error');
const userProfile = document.getElementById('user-profile');
const userHandleSpan = document.getElementById('user-handle');
const logoutBtn = document.getElementById('logout-btn');

const syncProgressBar = document.getElementById('sync-progress-bar');
const syncStage = document.getElementById('sync-stage');
const syncPercent = document.getElementById('sync-percent');
const syncError = document.getElementById('sync-error');
const cancelSyncBtn = document.getElementById('cancel-sync-btn');
const retrySyncBtn = document.getElementById('retry-sync-btn');

const tableBody = document.getElementById('table-body');
const tableSearch = document.getElementById('table-search');
const selectAllCheckbox = document.getElementById('select-all');
const batchUnfollowBtn = document.getElementById('batch-unfollow-btn');
const selectedCountSpan = document.getElementById('selected-count');
const emptyState = document.getElementById('empty-state');

const paginationInfos = document.querySelectorAll('.pagination-info');
const paginationPagesList = document.querySelectorAll('.pagination-pages');
const prevPageBtns = document.querySelectorAll('.prev-page-btn');
const nextPageBtns = document.querySelectorAll('.next-page-btn');

const resyncBtn = document.getElementById('resync-btn');
const lastSyncedTime = document.getElementById('last-synced-time');

// Unfollow Confirmation Modal Elements
const confirmModal = document.getElementById('confirm-modal');
const modalTitle = document.getElementById('modal-title');
const modalDesc = document.getElementById('modal-desc');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
  // Conforms with RFC 8252 loopback IP policies (which prohibit "localhost" hostnames)
  if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
    return;
  }

  initializeStateFromDOM();
  setupEventListeners();

  // Handle errors redirected back from OAuth flow
  const urlParams = new URLSearchParams(window.location.search);
  const callbackError = urlParams.get('error');
  if (callbackError) {
    loginError.textContent = decodeURIComponent(callbackError);
    loginError.classList.remove('hidden');
    // Clear URL parameters without triggering a reload
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  await checkSession();
});

// --- Event Handlers Setup ---
function setupEventListeners() {
  // Login Form
  loginForm.addEventListener('submit', handleLogin);

  // Logout Button
  logoutBtn.addEventListener('click', handleLogout);

  // Resync Button
  resyncBtn.addEventListener('click', triggerSync);

  // Live weights adjustments
  const weights = [
    'not-following',
    'inactive',
    'no-inbound',
    'no-outbound',
    'deleted-banned',
    'blocking',
    'noisy',
    'muted',
    'mass-follower',
    'spammy-ratio',
    'flagged',
    'outlier',
  ];
  weights.forEach((w) => {
    const slider = document.getElementById(`weight-${w}`);
    const valDisplay = document.getElementById(`val-${w}`);

    // Convert hyphenated back to camelCase for state
    const stateKey = w.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      valDisplay.textContent = val;
      state.weights[stateKey] = val;
      renderDashboard(); // Re-render table and update scores instantly
    });
  });

  // Checkboxes Filters
  const filterCheckboxes = [
    { id: 'filter-ok', key: 'ok' },
    { id: 'filter-not-following', key: 'notFollowing' },
    { id: 'filter-inactive', key: 'inactive' },
    { id: 'filter-no-inbound', key: 'noInbound' },
    { id: 'filter-no-outbound', key: 'noOutbound' },
    { id: 'filter-deleted-banned', key: 'deletedBanned' },
    { id: 'filter-blocking', key: 'blocking' },
    { id: 'filter-low-followers', key: 'lowFollowers' },
    { id: 'filter-noisy', key: 'noisy' },
    { id: 'filter-muted', key: 'muted' },
    { id: 'filter-mass-follower', key: 'massFollower' },
    { id: 'filter-spammy-ratio', key: 'spammyRatio' },
    { id: 'filter-flagged', key: 'flagged' },
    { id: 'filter-outlier', key: 'outlier' },
  ];

  filterCheckboxes.forEach((f) => {
    const checkbox = document.getElementById(f.id);
    checkbox.addEventListener('change', (e) => {
      state.filters[f.key] = e.target.checked;
      state.pagination.currentPage = 1; // Reset to page 1 on filter
      renderDashboard();
    });
  });

  // Parameters
  document.getElementById('param-inactive-days').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) || 90;
    state.params.inactiveDays = val;
    renderDashboard();
  });

  document.getElementById('param-low-followers').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) || 50;
    state.params.lowFollowersThreshold = val;
    renderDashboard();
  });

  document.getElementById('param-noisy-posts').addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10) || 20;
    if (val > 100) {
      val = 100;
      e.target.value = '100';
    }
    state.params.noisyPostsThreshold = val;
    renderDashboard();
  });

  document.getElementById('param-mass-follower').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10) || 3500;
    state.params.massFollowerThreshold = val;
    renderDashboard();
  });

  // Search input with basic debounce
  let searchTimeout;
  tableSearch.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.searchQuery = e.target.value.trim();
      state.pagination.currentPage = 1;
      renderDashboard();
    }, 200);
  });

  // Select All checkbox
  selectAllCheckbox.addEventListener('change', handleSelectAllToggle);

  // Table header sorting
  document.querySelectorAll('.sortable').forEach((th) => {
    th.addEventListener('click', () => {
      const sortCol = th.dataset.sort;
      if (state.sorting.col === sortCol) {
        state.sorting.order = state.sorting.order === 'asc' ? 'desc' : 'asc';
      } else {
        state.sorting.col = sortCol;
        state.sorting.order = 'asc';
      }
      renderDashboard();
    });
  });

  // Pagination buttons (bound to both top and bottom sets)
  prevPageBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.pagination.currentPage > 1) {
        state.pagination.currentPage--;
        renderDashboard(false); // don't reset selection
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  nextPageBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const totalPages = Math.ceil(getFilteredAndSortedList().length / state.pagination.pageSize);
      if (state.pagination.currentPage < totalPages) {
        state.pagination.currentPage++;
        renderDashboard(false); // don't reset selection
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  });

  // Batch Unfollow Button (Direct if <= 10, Modal if > 10)
  batchUnfollowBtn.addEventListener('click', () => {
    const dids = Array.from(state.selectedDids);
    if (dids.length > 0) {
      if (dids.length > 10) {
        state.pendingUnfollowDids = dids;
        modalTitle.textContent = 'Batch Unfollow Confirmation';
        modalDesc.textContent = `Are you sure you want to unfollow ${dids.length} selected accounts? This batch operation cannot be easily undone.`;
        confirmModal.classList.remove('hidden');
      } else {
        executeUnfollow(dids);
      }
    }
  });

  // Modal Confirm & Cancel buttons and backdrop click
  modalCancelBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    state.pendingUnfollowDids = [];
  });

  modalConfirmBtn.addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    const dids = state.pendingUnfollowDids;
    state.pendingUnfollowDids = [];
    if (dids.length > 0) {
      executeUnfollow(dids);
    }
  });

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      confirmModal.classList.add('hidden');
      state.pendingUnfollowDids = [];
    }
  });

  // Cancel and Retry Sync buttons
  cancelSyncBtn.addEventListener('click', handleCancelSync);
  retrySyncBtn.addEventListener('click', handleRetrySync);
}

function initializeStateFromDOM() {
  state.weights.notFollowing =
    parseInt(document.getElementById('weight-not-following').value, 10) || 1;
  state.weights.inactive = parseInt(document.getElementById('weight-inactive').value, 10) || 4;
  state.weights.noInbound = parseInt(document.getElementById('weight-no-inbound').value, 10) || 1;
  state.weights.noOutbound = parseInt(document.getElementById('weight-no-outbound').value, 10) || 5;
  state.weights.deletedBanned =
    parseInt(document.getElementById('weight-deleted-banned').value, 10) || 4;
  state.weights.blocking = parseInt(document.getElementById('weight-blocking').value, 10) || 4;
  state.weights.noisy = parseInt(document.getElementById('weight-noisy').value, 10) || 1;
  state.weights.muted = parseInt(document.getElementById('weight-muted').value, 10) || 4;
  state.weights.massFollower =
    parseInt(document.getElementById('weight-mass-follower').value, 10) || 1;
  state.weights.spammyRatio =
    parseInt(document.getElementById('weight-spammy-ratio').value, 10) || 1;
  state.weights.flagged = parseInt(document.getElementById('weight-flagged').value, 10) || 3;
  state.weights.outlier = parseInt(document.getElementById('weight-outlier').value, 10) || 1;

  state.filters.ok = document.getElementById('filter-ok').checked;
  state.filters.notFollowing = document.getElementById('filter-not-following').checked;
  state.filters.inactive = document.getElementById('filter-inactive').checked;
  state.filters.noInbound = document.getElementById('filter-no-inbound').checked;
  state.filters.noOutbound = document.getElementById('filter-no-outbound').checked;
  state.filters.deletedBanned = document.getElementById('filter-deleted-banned').checked;
  state.filters.blocking = document.getElementById('filter-blocking').checked;
  state.filters.lowFollowers = document.getElementById('filter-low-followers').checked;
  state.filters.noisy = document.getElementById('filter-noisy').checked;
  state.filters.muted = document.getElementById('filter-muted').checked;
  state.filters.massFollower = document.getElementById('filter-mass-follower').checked;
  state.filters.spammyRatio = document.getElementById('filter-spammy-ratio').checked;
  state.filters.flagged = document.getElementById('filter-flagged').checked;
  state.filters.outlier = document.getElementById('filter-outlier').checked;

  state.params.inactiveDays =
    parseInt(document.getElementById('param-inactive-days').value, 10) || 180;
  state.params.lowFollowersThreshold =
    parseInt(document.getElementById('param-low-followers').value, 10) || 50;
  let noisyVal = parseInt(document.getElementById('param-noisy-posts').value, 10) || 20;
  if (noisyVal > 100) {
    noisyVal = 100;
    document.getElementById('param-noisy-posts').value = '100';
  }
  state.params.noisyPostsThreshold = noisyVal;
  state.params.massFollowerThreshold =
    parseInt(document.getElementById('param-mass-follower').value, 10) || 3500;
}

// --- Session & Authentication ---
async function checkSession() {
  try {
    const oauthClient = initOAuthClient();
    const result = await oauthClient.init();

    if (result && result.session) {
      state.session = result.session;
      state.agent = new Agent(result.session);

      // Fetch profile via public AppView to completely bypass PDS CORS/proxy blocks on login
      const publicAgent = new Agent({ service: 'https://api.bsky.app' });
      const profile = await publicAgent.api.app.bsky.actor.getProfile({
        actor: result.session.did,
      });
      state.user = {
        loggedIn: true,
        did: result.session.did,
        handle: profile.data.handle,
      };

      showUserSession(state.user.handle);
      await checkSyncStatus();
    } else {
      state.user = null;
      showAuthSection();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    state.user = null;
    showAuthSection();
  }
}

async function handleLogin(e) {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginError.textContent = '';

  const handle = loginHandle.value.trim();
  if (!handle) return;

  try {
    const oauthClient = initOAuthClient();
    // Redirects browser window to user's PDS auth page
    await oauthClient.signIn(handle);
  } catch (err) {
    loginError.textContent = err.message || 'OAuth initiation failed.';
    loginError.classList.remove('hidden');
  }
}

async function handleLogout() {
  if (state.user && state.session) {
    try {
      await state.session.signOut();
    } catch (err) {
      console.warn('Signout error:', err);
    }
    await syncCache.clear(state.user.did);
  }

  state.user = null;
  state.session = null;
  state.agent = null;
  state.followings = [];
  state.selectedDids.clear();
  showAuthSection();
}

// --- Client-side Sync & Callback Updates ---
async function checkSyncStatus() {
  if (!state.user) return;

  try {
    const cachedState = await syncCache.get(state.user.did);
    state.sync = cachedState;

    if (cachedState.lastUpdated) {
      lastSyncedTime.textContent = formatLastSynced(cachedState.lastUpdated);
    } else {
      lastSyncedTime.textContent = '';
    }

    if (cachedState.status === 'idle') {
      await triggerSync();
    } else if (cachedState.status === 'fetching' || cachedState.status === 'enriching') {
      showSyncSection(cachedState);
      // Restart background sync in browser and attach update callback
      startBackgroundSync(state.agent, state.user.did, onSyncUpdate);
    } else if (cachedState.status === 'completed') {
      syncSection.classList.add('hidden');
      await loadFollowings();
    } else if (cachedState.status === 'cancelled') {
      showSyncCancelled(cachedState.error || 'Sync cancelled by user.');
    } else if (cachedState.status === 'error') {
      showSyncError(cachedState.error);
    }
  } catch (err) {
    console.error('Check sync error:', err);
  }
}

async function triggerSync() {
  if (!state.user) return;
  state.selectedDids.clear();
  selectAllCheckbox.checked = false;

  try {
    // 1. Signal cancellation to any currently running background sync thread
    await syncCache.set(state.user.did, {
      status: 'cancelled',
      error: null,
    });

    // 2. Wait 300ms for active workers to detect cancellation and shut down gracefully
    await new Promise((r) => setTimeout(r, 300));

    // 3. Initialize fresh sync state
    await syncCache.set(state.user.did, {
      status: 'idle',
      error: null,
    });

    // Instantly check status & start background execution
    const cachedState = await syncCache.get(state.user.did);
    showSyncSection(cachedState);
    startBackgroundSync(state.agent, state.user.did, onSyncUpdate);
  } catch (err) {
    console.error('Trigger sync error:', err);
  }
}

/**
 * Event-driven callback executed by atproto.js background sync loops.
 * Avoids browser CPU polling loops.
 */
async function onSyncUpdate() {
  if (!state.user) return;

  try {
    const cachedState = await syncCache.get(state.user.did);
    state.sync = cachedState;

    if (cachedState.lastUpdated) {
      lastSyncedTime.textContent = formatLastSynced(cachedState.lastUpdated);
    } else {
      lastSyncedTime.textContent = '';
    }

    updateSyncProgressUI(cachedState);

    if (cachedState.status === 'completed') {
      await loadFollowings();
    } else if (cachedState.status === 'cancelled') {
      showSyncCancelled(cachedState.error || 'Sync cancelled by user.');
    } else if (cachedState.status === 'error') {
      showSyncError(cachedState.error);
    } else if (cachedState.status === 'enriching') {
      // Progressively refresh the dashboard list incrementally as data enriches
      state.followings = cachedState.followings || [];
      renderDashboard(false);
    }
  } catch (err) {
    console.warn('Sync update handling error:', err);
  }
}

async function loadFollowings() {
  if (!state.user) return;

  try {
    const cachedState = await syncCache.get(state.user.did);
    state.followings = cachedState.followings || [];

    // Hide progress and auth connection card, show dashboard
    authSection.classList.add('hidden');
    syncSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    renderDashboard();
  } catch (err) {
    console.error('Load followings error:', err);
  }
}

// --- Scoring, Filtering & Sorting Computations ---
function calculateScore(item) {
  if (item.criteria.isDeleted || item.criteria.isBanned) {
    return state.weights.deletedBanned;
  }
  let score = 0;

  if (!item.criteria.isFollowingUser) {
    score += state.weights.notFollowing;
  }

  let isInactive = isUserInactive(item);
  if (isInactive) {
    score += state.weights.inactive;
  }

  const hasInbound =
    item.criteria.hasLikedUser ||
    item.criteria.hasRepostedUser ||
    item.criteria.hasRepliedToUser ||
    item.criteria.hasMessagedUser ||
    item.criteria.userInteracted;
  if (!hasInbound) {
    score += state.weights.noInbound;
  }

  const hasOutbound = item.criteria.userContactedThem;
  if (!hasOutbound) {
    score += state.weights.noOutbound;
  }

  if (item.criteria.isBlocking || item.criteria.isBlocked) {
    score += state.weights.blocking;
  }

  if (isUserNoisy(item)) {
    score += state.weights.noisy;
  }

  if (item.criteria.isMuted) {
    score += state.weights.muted;
  }

  if (isUserMassFollower(item)) {
    score += state.weights.massFollower;
  }

  if (item.criteria.isSpammyRatio) {
    score += state.weights.spammyRatio;
  }

  if (item.criteria.isFlagged) {
    score += state.weights.flagged;
  }

  if (item.criteria.isOutlier) {
    score += state.weights.outlier;
  }

  return score;
}

function isUserInactive(item) {
  if (item.criteria.lastPostDate) {
    const lastPost = new Date(item.criteria.lastPostDate).getTime();
    const daysSincePost = (Date.now() - lastPost) / (1000 * 60 * 60 * 24);
    return daysSincePost > state.params.inactiveDays;
  }
  return true; // Never posted/no postsCount
}

function isUserNoisy(item) {
  const threshold = state.params.noisyPostsThreshold || 20;
  if (item.criteria.postsCount7Days !== undefined) {
    return item.criteria.postsCount7Days >= threshold;
  }
  return !!item.criteria.isNoisy;
}

function isUserMassFollower(item) {
  const threshold = state.params.massFollowerThreshold || 3500;
  if (item.criteria.followsCount !== undefined) {
    return item.criteria.followsCount >= threshold;
  }
  return !!item.criteria.isMassFollower;
}

function getFilteredAndSortedList() {
  return state.followings
    .map((item) => {
      const score = calculateScore(item);
      const dynamicInactive = isUserInactive(item);
      return { ...item, score, dynamicInactive };
    })
    .filter((item) => {
      // Search
      if (state.searchQuery) {
        const q = state.searchQuery.toLowerCase();
        const nMatch = item.displayName && item.displayName.toLowerCase().includes(q);
        const hMatch = item.handle && item.handle.toLowerCase().includes(q);
        if (!nMatch && !hMatch) return false;
      }

      // Determine warning/inactive criteria matches
      const hasInbound =
        item.criteria.hasLikedUser ||
        item.criteria.hasRepostedUser ||
        item.criteria.hasRepliedToUser ||
        item.criteria.hasMessagedUser ||
        item.criteria.userInteracted;

      const hasOutbound = item.criteria.userContactedThem;

      const criteriaMatches = {
        notFollowing: !item.criteria.isFollowingUser,
        inactive: item.dynamicInactive,
        noInbound: !hasInbound,
        noOutbound: !hasOutbound,
        deletedBanned: !!(item.criteria.isDeleted || item.criteria.isBanned),
        blocking: !!(item.criteria.isBlocking || item.criteria.isBlocked),
        lowFollowers: item.criteria.followersCount < state.params.lowFollowersThreshold,
        noisy: isUserNoisy(item),
        muted: !!item.criteria.isMuted,
        massFollower: isUserMassFollower(item),
        spammyRatio: !!item.criteria.isSpammyRatio,
        flagged: !!item.criteria.isFlagged,
        outlier: !!item.criteria.isOutlier,
      };

      // Account has "OK" status if it has none of the warning/inactive flags
      const isOk =
        !criteriaMatches.notFollowing &&
        !criteriaMatches.inactive &&
        !criteriaMatches.noInbound &&
        !criteriaMatches.noOutbound &&
        !criteriaMatches.deletedBanned &&
        !criteriaMatches.blocking &&
        !criteriaMatches.lowFollowers &&
        !criteriaMatches.noisy &&
        !criteriaMatches.muted &&
        !criteriaMatches.massFollower &&
        !criteriaMatches.spammyRatio &&
        !criteriaMatches.flagged &&
        !criteriaMatches.outlier;

      // OR Filter check: The item is shown if it matches at least one checked criterion
      let matchesFilter = false;

      if (isOk && state.filters.ok) matchesFilter = true;
      if (criteriaMatches.notFollowing && state.filters.notFollowing) matchesFilter = true;
      if (criteriaMatches.inactive && state.filters.inactive) matchesFilter = true;
      if (criteriaMatches.noInbound && state.filters.noInbound) matchesFilter = true;
      if (criteriaMatches.noOutbound && state.filters.noOutbound) matchesFilter = true;
      if (criteriaMatches.deletedBanned && state.filters.deletedBanned) matchesFilter = true;
      if (criteriaMatches.blocking && state.filters.blocking) matchesFilter = true;
      if (criteriaMatches.lowFollowers && state.filters.lowFollowers) matchesFilter = true;
      if (criteriaMatches.noisy && state.filters.noisy) matchesFilter = true;
      if (criteriaMatches.muted && state.filters.muted) matchesFilter = true;
      if (criteriaMatches.massFollower && state.filters.massFollower) matchesFilter = true;
      if (criteriaMatches.spammyRatio && state.filters.spammyRatio) matchesFilter = true;
      if (criteriaMatches.flagged && state.filters.flagged) matchesFilter = true;
      if (criteriaMatches.outlier && state.filters.outlier) matchesFilter = true;

      return matchesFilter;
    })
    .sort((a, b) => {
      let valA, valB;
      if (state.sorting.col === 'followers') {
        valA = a.criteria.followersCount;
        valB = b.criteria.followersCount;
      } else if (state.sorting.col === 'lastPost') {
        valA = a.criteria.lastPostDate ? new Date(a.criteria.lastPostDate).getTime() : 0;
        valB = b.criteria.lastPostDate ? new Date(b.criteria.lastPostDate).getTime() : 0;
      } else if (state.sorting.col === 'lastInteraction') {
        const dateA = a.criteria.lastInteraction?.date || a.criteria.lastLikeDate;
        const dateB = b.criteria.lastInteraction?.date || b.criteria.lastLikeDate;
        valA = dateA ? new Date(dateA).getTime() : 0;
        valB = dateB ? new Date(dateB).getTime() : 0;
      } else if (state.sorting.col === 'score') {
        valA = a.score;
        valB = b.score;
      }

      if (valA < valB) return state.sorting.order === 'asc' ? -1 : 1;
      if (valA > valB) return state.sorting.order === 'asc' ? 1 : -1;
      return 0;
    });
}

// --- Render Operations ---
function renderDashboard(resetSelection = true) {
  if (resetSelection) {
    state.selectedDids.clear();
    selectAllCheckbox.checked = false;
  }

  const list = getFilteredAndSortedList();
  const totalCount = list.length;

  // Handle pagination clamp
  const totalPages = Math.ceil(totalCount / state.pagination.pageSize) || 1;
  if (state.pagination.currentPage > totalPages) {
    state.pagination.currentPage = totalPages;
  }

  const startIdx = (state.pagination.currentPage - 1) * state.pagination.pageSize;
  const endIdx = Math.min(startIdx + state.pagination.pageSize, totalCount);
  const pageItems = list.slice(startIdx, endIdx);

  // Render Table rows
  tableBody.innerHTML = '';

  if (pageItems.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    pageItems.forEach((item) => {
      const row = document.createElement('tr');
      row.className = state.selectedDids.has(item.did) ? 'selected-row' : '';

      // Build criteria badges (shortened with descriptive titles to save screen space)
      let badgesHTML = '';
      if (item.criteria.isDeleted) {
        badgesHTML +=
          '<span class="badge badge-danger" title="This account has been deleted or deactivated">DELETED</span>';
      }
      if (item.criteria.isBanned) {
        badgesHTML +=
          '<span class="badge badge-danger" title="This account has been suspended or flagged by Bluesky">BANNED</span>';
      }
      if (item.criteria.isBlocking || item.criteria.isBlocked) {
        badgesHTML +=
          '<span class="badge badge-danger" title="This account is blocking you or blocked by you">BLOCK</span>';
      }
      if (item.dynamicInactive) {
        badgesHTML += `<span class="badge badge-warning" title="Inactive: has not posted in the last ${state.params.inactiveDays} days">INACTIVE</span>`;
      }
      if (!item.criteria.isFollowingUser) {
        badgesHTML +=
          '<span class="badge badge-secondary" title="This account does not follow you back">NO FOLLOW</span>';
      }

      const hasInbound =
        item.criteria.hasLikedUser ||
        item.criteria.hasRepostedUser ||
        item.criteria.hasRepliedToUser ||
        item.criteria.hasMessagedUser ||
        item.criteria.userInteracted;
      const hasOutbound = item.criteria.userContactedThem;

      let warningsCount = 0;
      if (item.criteria.isDeleted || item.criteria.isBanned) warningsCount++;
      if (item.criteria.isBlocking || item.criteria.isBlocked) warningsCount++;
      if (item.dynamicInactive) warningsCount++;
      if (!item.criteria.isFollowingUser) warningsCount++;

      if (!hasInbound) {
        badgesHTML +=
          '<span class="badge badge-secondary" title="They have not liked, replied, or messaged you recently (scanned last 1,000 notifications)">NO INBOUND</span>';
        warningsCount++;
      } else {
        badgesHTML +=
          '<span class="badge badge-success" title="They liked, replied, or messaged you recently (scanned last 1,000 notifications)">THEY CONTACTED</span>';
      }

      if (!hasOutbound) {
        badgesHTML +=
          '<span class="badge badge-secondary" title="You have not liked, replied, or reposted them recently (scanned last 1,000 activities)">NO OUTBOUND</span>';
        warningsCount++;
      } else {
        badgesHTML +=
          '<span class="badge badge-success" title="You liked, replied, or reposted them recently (scanned last 1,000 activities)">I CONTACTED</span>';
      }

      if (isUserNoisy(item)) {
        const countStr =
          item.criteria.postsCount7Days !== undefined ? `${item.criteria.postsCount7Days}` : '10+';
        badgesHTML += `<span class="badge badge-warning" title="Noisy Poster: Writes high frequency of posts/reposts (${countStr} in last 7 days)">NOISY</span>`;
        warningsCount++;
      }

      if (item.criteria.isMuted) {
        badgesHTML +=
          '<span class="badge badge-danger" title="Muted: This account is currently muted by you on Bluesky">MUTED</span>';
        warningsCount++;
      }

      if (isUserMassFollower(item)) {
        const followsCountStr =
          item.criteria.followsCount !== undefined
            ? `${item.criteria.followsCount.toLocaleString()}`
            : '3,500+';
        badgesHTML += `<span class="badge badge-warning" title="Mass Follower: Follows ${followsCountStr} accounts on Bluesky">MASS FOLLOW</span>`;
        warningsCount++;
      }

      if (item.criteria.isSpammyRatio) {
        badgesHTML +=
          '<span class="badge badge-danger" title="Spammy Ratio: Following count is significantly higher than followers count (follow-back farmer)">SPAMMY RATIO</span>';
        warningsCount++;
      }

      if (item.criteria.isFlagged) {
        badgesHTML +=
          '<span class="badge badge-danger" title="Flagged: This account has moderation flags or labels from Bluesky Moderation">FLAGGED</span>';
        warningsCount++;
      }

      if (item.criteria.isOutlier) {
        badgesHTML +=
          '<span class="badge badge-warning" title="Social Outlier: Has 0 mutual follows in common with you on Bluesky">0 MUTUALS</span>';
        warningsCount++;
      } else if (item.criteria.mutualsCount > 0) {
        badgesHTML += `<span class="badge badge-success" title="Mutual Social Graph: Has ${item.criteria.mutualsCount} mutual follows in common with you on Bluesky">${item.criteria.mutualsCount} MUTUALS</span>`;
      }

      if (warningsCount === 0) {
        badgesHTML =
          '<span class="badge badge-success" title="Meets all positive criteria checks">OK</span>';
      }

      // Score color class (0-5 scale: high score represents strong reason to unfollow)
      let scoreClass = 'score-high';
      if (item.score >= 4) scoreClass = 'score-low';
      else if (item.score >= 2) scoreClass = 'score-mid';

      const avatarSrc =
        item.avatar ||
        "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 24 24' fill='%23cbd5e1'><circle cx='12' cy='12' r='12'/></svg>";

      const isUnfollowed = !item.followingUri;
      if (isUnfollowed) {
        row.classList.add('unfollowed-row');
      } else if (state.selectedDids.has(item.did)) {
        row.classList.add('selected-row');
      }

      const isLowFollowers = item.criteria.followersCount < state.params.lowFollowersThreshold;
      const isPostInactive = item.dynamicInactive;

      let isInteractionInactive = true;
      const lastInteractionDate = item.criteria.lastInteraction?.date || item.criteria.lastLikeDate;
      if (lastInteractionDate) {
        const lastInteraction = new Date(lastInteractionDate).getTime();
        const daysSinceInteraction = (Date.now() - lastInteraction) / (1000 * 60 * 60 * 24);
        isInteractionInactive = daysSinceInteraction > state.params.inactiveDays;
      }

      // Generate Last Interaction content with type label and bsky.app hyperlink
      const interactionInfo = item.criteria.lastInteraction;
      const renderDate = interactionInfo?.date || item.criteria.lastLikeDate;
      const relativeDateStr = formatRelativeDate(renderDate);

      let cellContentHTML = relativeDateStr;
      if (renderDate && relativeDateStr !== 'Never') {
        let typeLabel = '';
        if (interactionInfo?.type) {
          const typeMap = {
            like: 'Like',
            reply: 'Reply',
            repost: 'Repost',
            message: 'DM',
          };
          typeLabel = ` (${typeMap[interactionInfo.type] || interactionInfo.type})`;
        }

        const linkUrl = interactionInfo?.link;
        if (linkUrl) {
          cellContentHTML = `<a href="${linkUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;" title="View last ${interactionInfo.type} on Bluesky">${relativeDateStr}${typeLabel}</a>`;
        } else {
          cellContentHTML = `${relativeDateStr}${typeLabel}`;
        }
      }

      const displayNameHTML = truncateText(item.displayName || item.handle.split('.')[0], 16);
      const handleHTML = truncateText('@' + item.handle, 20);

      let checkboxHTML;
      if (isUnfollowed) {
        checkboxHTML = '<span class="text-muted text-center" style="display: block; opacity: 0.5;">—</span>';
      } else {
        const checkedAttr = state.selectedDids.has(item.did) ? 'checked' : '';
        checkboxHTML = `<input type="checkbox" class="row-checkbox" data-did="${item.did}" ${checkedAttr}>`;
      }

      row.innerHTML = `
        <td class="col-checkbox">
          ${checkboxHTML}
        </td>
        <td>
          <div class="profile-cell" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">
            <a href="https://bsky.app/profile/${item.handle}" target="_blank" rel="noopener noreferrer" class="profile-link">
              <img class="avatar" src="${avatarSrc}" alt="${item.handle}" loading="lazy">
              <div class="profile-info">
                <span class="display-name">${displayNameHTML}</span>
                <span class="handle">${handleHTML}</span>
              </div>
            </a>
          </div>
        </td>
        <td class="${isLowFollowers ? 'criteria-highlight' : ''}" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${item.criteria.followersCount.toLocaleString()}</td>
        <td class="${isPostInactive ? 'criteria-highlight' : ''}" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${formatRelativeDate(item.criteria.lastPostDate)}</td>
        <td class="${isInteractionInactive ? 'criteria-highlight' : ''}" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${cellContentHTML}</td>
        <td style="${isUnfollowed ? 'opacity: 0.5;' : ''}">
          <div class="flags-list">${isUnfollowed ? '<span class="badge badge-secondary">Unfollowed</span>' : badgesHTML}</div>
        </td>
        <td class="score-cell ${scoreClass}" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${item.score}</td>
        <td class="text-right">
          ${
            isUnfollowed
              ? `
            <button class="btn btn-primary btn-sm refollow-single-btn" data-did="${item.did}" data-handle="${item.handle}">Re-follow</button>
          `
              : `
            <button class="btn btn-secondary btn-sm unfollow-single-btn" data-did="${item.did}" data-handle="${item.handle}">Unfollow</button>
          `
          }
        </td>
      `;

      if (isUnfollowed) {
        row.querySelector('.refollow-single-btn').addEventListener('click', async (e) => {
          const did = e.target.dataset.did;
          const handle = e.target.dataset.handle;
          await handleRefollow(did, handle, e.target);
        });
      } else {
        row.querySelector('.row-checkbox').addEventListener('change', (e) => {
          if (e.target.checked) {
            state.selectedDids.add(item.did);
          } else {
            state.selectedDids.delete(item.did);
          }
          updateSelectedCounter();
          renderCheckboxHeaders(pageItems);
        });

        row.querySelector('.unfollow-single-btn').addEventListener('click', async (e) => {
          const did = e.target.dataset.did;
          await executeUnfollow([did], e.target);
        });
      }

      tableBody.appendChild(row);
    });
  }

  // Render sorting indicators on headers
  document.querySelectorAll('.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    const sortCol = th.dataset.sort;
    if (state.sorting.col === sortCol) {
      th.classList.add(state.sorting.order === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });

  // Render Pagination Info (Concurrently for top & bottom)
  paginationInfos.forEach((el) => {
    if (totalCount === 0) {
      el.textContent = 'Showing 0 accounts';
    } else {
      el.textContent = `Showing ${startIdx + 1} - ${endIdx} of ${totalCount} accounts`;
    }
  });

  // Page Numbers (Concurrently for top & bottom)
  paginationPagesList.forEach((container) => {
    container.innerHTML = '';
    const maxPagesToShow = 5;
    let startPage = Math.max(1, state.pagination.currentPage - 2);
    let endPage = Math.min(totalPages, startPage + maxPagesToShow - 1);
    if (endPage - startPage < maxPagesToShow - 1) {
      startPage = Math.max(1, endPage - maxPagesToShow + 1);
    }

    for (let i = startPage; i <= endPage; i++) {
      const pageBtn = document.createElement('button');
      pageBtn.className = `page-link ${state.pagination.currentPage === i ? 'active' : ''}`;
      pageBtn.textContent = i;
      pageBtn.addEventListener('click', () => {
        state.pagination.currentPage = i;
        renderDashboard(false);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      container.appendChild(pageBtn);
    }
  });

  prevPageBtns.forEach((btn) => {
    btn.disabled = state.pagination.currentPage === 1;
  });

  nextPageBtns.forEach((btn) => {
    btn.disabled = state.pagination.currentPage === totalPages || totalPages === 0;
  });

  renderCheckboxHeaders(pageItems);
  updateSelectedCounter();
}

function renderCheckboxHeaders(pageItems) {
  if (pageItems.length === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.disabled = true;
    return;
  }
  selectAllCheckbox.disabled = false;
  const allPageDidsSelected = pageItems.every((item) => state.selectedDids.has(item.did));
  selectAllCheckbox.checked = allPageDidsSelected;
}

function handleSelectAllToggle(e) {
  const list = getFilteredAndSortedList();
  const startIdx = (state.pagination.currentPage - 1) * state.pagination.pageSize;
  const endIdx = Math.min(startIdx + state.pagination.pageSize, list.length);
  const pageItems = list.slice(startIdx, endIdx);

  if (e.target.checked) {
    pageItems.forEach((item) => state.selectedDids.add(item.did));
  } else {
    pageItems.forEach((item) => state.selectedDids.delete(item.did));
  }
  renderDashboard(false);
}

function updateSelectedCounter() {
  const count = state.selectedDids.size;
  selectedCountSpan.textContent = count;
  if (count > 0) {
    batchUnfollowBtn.classList.remove('hidden');
    batchUnfollowBtn.disabled = false;
  } else {
    batchUnfollowBtn.classList.add('hidden');
    batchUnfollowBtn.disabled = true;
  }
}

// --- Action Logic ---
async function executeUnfollow(dids, buttonEl) {
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'unfollowing...';
  }

  if (!buttonEl && dids.length > 0) {
    batchUnfollowBtn.disabled = true;
    batchUnfollowBtn.textContent = 'Unfollowing...';
  }

  try {
    const data = await batchUnfollow(state.agent, state.user.did, dids, onSyncUpdate);

    // Mark successfully unfollowed DIDs as unfollowed in raw state list
    const successes = data.success || [];
    successes.forEach((did) => {
      const f = state.followings.find((item) => item.did === did);
      if (f) {
        f.followingUri = null;
      }
    });

    // Clear selections
    successes.forEach((did) => state.selectedDids.delete(did));

    renderDashboard(false); // Re-render without resetting selection
  } catch (err) {
    alert('Error during unfollow operation: ' + err.message);
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.textContent = 'Unfollow';
    }
  } finally {
    batchUnfollowBtn.textContent = 'Unfollow Selected';
    updateSelectedCounter();
  }
}

async function handleRefollow(did, handle, buttonEl) {
  buttonEl.disabled = true;
  buttonEl.textContent = 'Re-following...';

  try {
    const data = await followUser(state.agent, state.user.did, did, onSyncUpdate);

    // Update in-memory following object's URI
    const f = state.followings.find((item) => item.did === did);
    if (f) {
      f.followingUri = data.followingUri;
    }

    renderDashboard(false); // Re-render without resetting selection
  } catch (err) {
    alert('Error during re-follow: ' + err.message);
    buttonEl.disabled = false;
    buttonEl.textContent = 'Re-follow';
  }
}

// --- Styling/State Presentation Helpers ---
function showAuthSection() {
  authSection.classList.remove('hidden');
  syncSection.classList.add('hidden');
  dashboardSection.classList.add('hidden');
  userProfile.classList.add('hidden');
}

function showUserSession(handle) {
  userHandleSpan.textContent = `@${handle}`;
  userProfile.classList.remove('hidden');
}

function showSyncSection(syncState) {
  authSection.classList.add('hidden');
  dashboardSection.classList.add('hidden');
  syncSection.classList.remove('hidden');
  syncError.classList.add('hidden');
  cancelSyncBtn.classList.remove('hidden');
  retrySyncBtn.classList.add('hidden');
  updateSyncProgressUI(syncState);
}

function showSyncError(errMessage) {
  syncStage.textContent = 'Sync Failed';
  syncPercent.textContent = '';
  syncError.textContent = errMessage;
  syncError.classList.remove('hidden');
  cancelSyncBtn.classList.add('hidden');
  retrySyncBtn.classList.remove('hidden');
}

function showSyncCancelled(errMessage) {
  syncStage.textContent = 'Sync Cancelled';
  syncPercent.textContent = '';
  syncError.textContent = errMessage;
  syncError.classList.remove('hidden');
  cancelSyncBtn.classList.add('hidden');
  retrySyncBtn.classList.remove('hidden');
}

async function handleCancelSync() {
  cancelSyncBtn.disabled = true;
  cancelSyncBtn.textContent = 'Cancelling...';
  try {
    await syncCache.set(state.user.did, {
      status: 'cancelled',
      error: 'Synchronization aborted by user.',
    });
    showSyncCancelled('Synchronization aborted by user.');
  } catch (err) {
    console.error('Cancel sync error:', err);
  } finally {
    cancelSyncBtn.disabled = false;
    cancelSyncBtn.textContent = 'Cancel Sync';
  }
}

async function handleRetrySync() {
  retrySyncBtn.classList.add('hidden');
  cancelSyncBtn.classList.remove('hidden');
  syncError.classList.add('hidden');
  await triggerSync();
}

function updateSyncProgressUI(syncState) {
  syncStage.textContent = syncState.progress.currentStage || 'Syncing...';

  let percent = 0;
  if (syncState.progress.total > 0) {
    percent = Math.round((syncState.progress.processed / syncState.progress.total) * 100);
  } else if (syncState.status === 'fetching' && syncState.totalCount > 0) {
    percent = 25; // Dummy progress for fetching follows phase
  } else if (syncState.status === 'enriching') {
    percent = 50; // Dummy baseline
  }

  syncProgressBar.style.width = `${percent}%`;
  syncPercent.textContent = `${percent}%`;
}

function formatRelativeDate(dateStr) {
  if (!dateStr) return 'Never';
  const timestamp = new Date(dateStr).getTime();
  const diffMs = Date.now() - timestamp;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) {
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours <= 0) return 'Just now';
    return `${diffHours}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 30) return `${diffDays}d ago`;

  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(
    /[&<>'"]/g,
    (tag) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[tag] || tag,
  );
}

function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return escapeHTML(text);
  const truncated = text.substring(0, maxLength - 3) + '...';
  return `<abbr title="${escapeHTML(text)}" style="text-decoration: none; cursor: help; border-bottom: none;">${escapeHTML(truncated)}</abbr>`;
}

function formatLastSynced(timestamp) {
  if (!timestamp) return 'Never synced';
  const date = new Date(timestamp);
  return (
    'Last synced: ' +
    date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  );
}
