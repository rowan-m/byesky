import { Agent } from '@atproto/api';
import {
  initOAuthClient,
  startBackgroundSync,
  batchUnfollow,
  followUser,
  fetchAccountPreview,
} from './atproto.js';
import { syncCache } from './cache.js';
import {
  isUserNoisy,
  isUserMassFollower,
  filterAndSortFollowings,
  escapeHTML,
  sanitizeUrl,
  truncateText,
} from './scoring.js';

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
  lockedDids: new Set(), // DIDs protected from Select All and unfollowing
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
    inactive: 3,
    neverPosted: 4,
    noInbound: 1,
    noOutbound: 5,
    deletedBanned: 4,
    blocking: 4,
    lowFollowers: 0,
    noisy: 1,
    muted: 4,
    massFollower: 1,
    spammyRatio: 1,
    flagged: 3,
    outlier: 1,
  },
  filters: {
    ok: true,
    locked: true,
    notFollowing: true,
    inactive: true,
    neverPosted: true,
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
const appLoadingSection = document.getElementById('app-loading-section');
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

// Singleton Rich Hover Preview Card
const hoverCard = document.getElementById('profile-hover-card');
let hoverShowTimeout = null;
let hoverHideTimeout = null;
let activeHoverDid = null;

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
    'never-posted',
    'no-inbound',
    'no-outbound',
    'deleted-banned',
    'blocking',
    'low-followers',
    'noisy',
    'muted',
    'mass-follower',
    'spammy-ratio',
    'flagged',
    'outlier',
  ];
  weights.forEach((w) => {
    const slider = document.getElementById(`weight-${w}`);

    // Convert hyphenated back to camelCase for state
    const stateKey = w.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      state.weights[stateKey] = val;
      renderDashboard(); // Re-render table and update scores instantly
    });

    enhanceWeightControl(slider);
  });

  // Checkboxes Filters
  const filterCheckboxes = [
    { id: 'filter-ok', key: 'ok' },
    { id: 'filter-locked', key: 'locked' },
    { id: 'filter-not-following', key: 'notFollowing' },
    { id: 'filter-inactive', key: 'inactive' },
    { id: 'filter-never-posted', key: 'neverPosted' },
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
    const parentItem = checkbox.closest('.criteria-item');
    if (parentItem) {
      parentItem.classList.toggle('is-filtered-out', !checkbox.checked);
    }
    checkbox.addEventListener('change', (e) => {
      state.filters[f.key] = e.target.checked;
      if (parentItem) {
        parentItem.classList.toggle('is-filtered-out', !e.target.checked);
      }
      state.pagination.currentPage = 1; // Reset to page 1 on filter
      updateConfigSummary();
      renderDashboard();
    });
  });

  setupConfigPanel();

  // Parameters
  document.getElementById('param-inactive-days').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.params.inactiveDays = Number.isNaN(val) ? 180 : val;
    renderDashboard();
  });

  document.getElementById('param-low-followers').addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.params.lowFollowersThreshold = Number.isNaN(val) ? 50 : val;
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

  // Keep singleton hover card visible when hovered directly
  if (hoverCard) {
    hoverCard.addEventListener('mouseenter', () => {
      clearTimeout(hoverHideTimeout);
    });
    hoverCard.addEventListener('mouseleave', () => {
      scheduleHideHoverCard();
    });
  }
  window.addEventListener(
    'scroll',
    () => {
      hideHoverCardImmediately();
    },
    { passive: true },
  );
}

// --- Criteria & Scoring Panel ---
const CONFIG_COLLAPSED_KEY = 'byesky:configCollapsed';
// Keep in sync with the narrow-layout breakpoint in style.css.
const narrowLayoutQuery = window.matchMedia('(max-width: 1100px)');

/**
 * Renders a 0–5 segmented radio group in place of a range slider. The (hidden) range
 * input remains the source of truth, so existing `input` listeners keep working.
 */
function enhanceWeightControl(slider) {
  const min = parseInt(slider.min, 10) || 0;
  const max = parseInt(slider.max, 10) || 5;

  const group = document.createElement('div');
  group.className = 'weight-seg';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', slider.getAttribute('aria-label') || 'Weight');

  const buttons = [];
  for (let v = min; v <= max; v++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weight-seg-btn';
    btn.textContent = String(v);
    btn.dataset.value = String(v);
    btn.setAttribute('role', 'radio');
    buttons.push(btn);
    group.appendChild(btn);
  }

  const sync = () => {
    const current = slider.value;
    buttons.forEach((btn) => {
      const isActive = btn.dataset.value === current;
      btn.setAttribute('aria-checked', String(isActive));
      btn.tabIndex = isActive ? 0 : -1; // roving tabindex
    });
  };

  const select = (value, focus = false) => {
    const clamped = Math.min(max, Math.max(min, value));
    if (String(clamped) !== slider.value) {
      slider.value = String(clamped);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    sync();
    if (focus) buttons[clamped - min].focus();
  };

  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.weight-seg-btn');
    if (btn) select(parseInt(btn.dataset.value, 10));
  });

  group.addEventListener('keydown', (e) => {
    const current = parseInt(slider.value, 10);
    const keyMap = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      Home: min,
      End: max,
    };
    if (e.key in keyMap) {
      e.preventDefault();
      select(keyMap[e.key], true);
    }
  });

  slider.classList.add('visually-hidden');
  slider.tabIndex = -1;
  slider.setAttribute('aria-hidden', 'true');
  slider.insertAdjacentElement('afterend', group);
  sync();
}

function readStoredConfigCollapsed() {
  try {
    return localStorage.getItem(CONFIG_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeConfigCollapsed(collapsed) {
  try {
    localStorage.setItem(CONFIG_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage unavailable (e.g. privacy mode); preference just won't persist.
  }
}

function setConfigCollapsed(collapsed) {
  const panel = document.getElementById('config-panel');
  const overlay = narrowLayoutQuery.matches && !collapsed;
  if (overlay && panel) {
    // Pin the expanded sheet exactly where the bar currently sits so it can be sized
    // against the visible viewport (a sticky element's offset varies with scroll).
    const rect = panel.getBoundingClientRect();
    const root = document.documentElement.style;
    root.setProperty('--config-panel-top', `${Math.max(0, Math.round(rect.top))}px`);
    root.setProperty('--config-panel-left', `${Math.round(rect.left)}px`);
    root.setProperty('--config-panel-w', `${Math.round(rect.width)}px`);
    root.setProperty('--config-bar-h', `${Math.round(rect.height)}px`);
  }
  document.documentElement.classList.toggle('is-config-overlay', overlay);
  document.querySelector('.dashboard-grid')?.classList.toggle('is-config-collapsed', collapsed);
  document.getElementById('config-toggle')?.setAttribute('aria-expanded', String(!collapsed));
}

/** Narrow screens always start collapsed; wide screens restore the user's last choice. */
function applyConfigLayout() {
  setConfigCollapsed(narrowLayoutQuery.matches ? true : readStoredConfigCollapsed());
}

function setupConfigPanel() {
  const toggle = document.getElementById('config-toggle');
  const grid = document.querySelector('.dashboard-grid');
  if (!toggle || !grid) return;

  toggle.addEventListener('click', () => {
    const collapsed = !grid.classList.contains('is-config-collapsed');
    setConfigCollapsed(collapsed);
    if (!narrowLayoutQuery.matches) storeConfigCollapsed(collapsed);
  });

  // Escape closes the expanded overlay-style panel on narrow screens.
  document.addEventListener('keydown', (e) => {
    if (
      e.key === 'Escape' &&
      narrowLayoutQuery.matches &&
      !grid.classList.contains('is-config-collapsed')
    ) {
      setConfigCollapsed(true);
      toggle.focus();
    }
  });

  // Tapping the backdrop outside the expanded sheet closes it on narrow screens.
  document.addEventListener('click', (e) => {
    if (
      narrowLayoutQuery.matches &&
      !grid.classList.contains('is-config-collapsed') &&
      e.target instanceof window.Node &&
      e.target.isConnected &&
      !document.getElementById('config-panel')?.contains(e.target)
    ) {
      setConfigCollapsed(true);
    }
  });

  narrowLayoutQuery.addEventListener('change', applyConfigLayout);

  // Re-anchor the open sheet when the width changes (e.g. rotation). Height-only
  // resizes (mobile browser chrome showing/hiding) are handled by dvh.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (narrowLayoutQuery.matches && !grid.classList.contains('is-config-collapsed')) {
      const body = document.getElementById('config-body');
      const scrollTop = body?.scrollTop ?? 0;
      setConfigCollapsed(true);
      setConfigCollapsed(false);
      if (body) body.scrollTop = scrollTop;
    }
  });
  applyConfigLayout();
  updateConfigSummary();

  // Expose the sticky header height so the sticky sidebar/top bar can sit beneath it.
  const header = document.querySelector('.app-header');
  if (header && 'ResizeObserver' in window) {
    new window.ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--header-h', `${height}px`);
    }).observe(header);
  }
}

function updateConfigSummary() {
  const summary = document.getElementById('config-summary');
  if (!summary) return;
  const hiddenCount = Object.values(state.filters).filter((shown) => !shown).length;
  const plural = hiddenCount === 1 ? '' : 's';
  summary.textContent = hiddenCount === 0 ? 'All shown' : `${hiddenCount} filter${plural} off`;
  summary.classList.toggle('has-hidden', hiddenCount > 0);
}

function initializeStateFromDOM() {
  state.weights.notFollowing =
    parseInt(document.getElementById('weight-not-following').value, 10) || 1;
  state.weights.inactive = parseInt(document.getElementById('weight-inactive').value, 10) || 3;
  state.weights.neverPosted =
    parseInt(document.getElementById('weight-never-posted').value, 10) || 4;
  state.weights.noInbound = parseInt(document.getElementById('weight-no-inbound').value, 10) || 1;
  state.weights.noOutbound = parseInt(document.getElementById('weight-no-outbound').value, 10) || 5;
  state.weights.deletedBanned =
    parseInt(document.getElementById('weight-deleted-banned').value, 10) || 4;
  state.weights.blocking = parseInt(document.getElementById('weight-blocking').value, 10) || 4;
  state.weights.lowFollowers =
    parseInt(document.getElementById('weight-low-followers')?.value ?? '0', 10) || 0;
  state.weights.noisy = parseInt(document.getElementById('weight-noisy').value, 10) || 1;
  state.weights.muted = parseInt(document.getElementById('weight-muted').value, 10) || 4;
  state.weights.massFollower =
    parseInt(document.getElementById('weight-mass-follower').value, 10) || 1;
  state.weights.spammyRatio =
    parseInt(document.getElementById('weight-spammy-ratio').value, 10) || 1;
  state.weights.flagged = parseInt(document.getElementById('weight-flagged').value, 10) || 3;
  state.weights.outlier = parseInt(document.getElementById('weight-outlier').value, 10) || 1;

  state.filters.ok = document.getElementById('filter-ok').checked;
  state.filters.locked = document.getElementById('filter-locked').checked;
  state.filters.notFollowing = document.getElementById('filter-not-following').checked;
  state.filters.inactive = document.getElementById('filter-inactive').checked;
  state.filters.neverPosted = document.getElementById('filter-never-posted').checked;
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
  state.lockedDids.clear();
  showAuthSection();
}

// --- Client-side Sync & Callback Updates ---
async function checkSyncStatus() {
  if (!state.user) return;

  try {
    const cachedState = await syncCache.get(state.user.did);
    state.sync = cachedState;
    state.lockedDids = new Set(await syncCache.getLockedDids(state.user.did));

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
    state.lockedDids = new Set(await syncCache.getLockedDids(state.user.did));

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
    state.lockedDids = new Set(await syncCache.getLockedDids(state.user.did));

    // Hide progress, loader, and auth connection card, show dashboard
    hideLoading();
    authSection.classList.add('hidden');
    syncSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    renderDashboard();
  } catch (err) {
    console.error('Load followings error:', err);
  }
}

// --- Scoring, Filtering & Sorting Computations ---
function getFilteredAndSortedList() {
  return filterAndSortFollowings(state.followings, state);
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
      if (item.neverPosted) {
        badgesHTML +=
          '<span class="badge badge-warning" title="Never Posted: This account has no posts on Bluesky">NEVER POSTED</span>';
      } else if (item.dynamicInactive) {
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
      if (item.neverPosted || item.dynamicInactive) warningsCount++;
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

      if (isUserNoisy(item, state.params.noisyPostsThreshold)) {
        const countStr =
          item.criteria.postsCount7Days !== undefined ? `${item.criteria.postsCount7Days}` : '10+';
        badgesHTML += `<span class="badge badge-warning" title="Noisy Poster: Writes high frequency of posts/reposts (${escapeHTML(countStr)} in last 7 days)">NOISY</span>`;
        warningsCount++;
      }

      if (item.criteria.isMuted) {
        badgesHTML +=
          '<span class="badge badge-danger" title="Muted: This account is currently muted by you on Bluesky">MUTED</span>';
        warningsCount++;
      }

      if (isUserMassFollower(item, state.params.massFollowerThreshold)) {
        const followsCountStr =
          item.criteria.followsCount !== undefined
            ? `${item.criteria.followsCount.toLocaleString()}`
            : '3,500+';
        badgesHTML += `<span class="badge badge-warning" title="Mass Follower: Follows ${escapeHTML(followsCountStr)} accounts on Bluesky">MASS FOLLOW</span>`;
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
        const mutualsLabel = formatMutualsCount(item.criteria);
        const mutualWord = item.criteria.mutualsCount === 1 ? 'MUTUAL' : 'MUTUALS';
        badgesHTML += `<span class="badge badge-success" title="Mutual Social Graph: Has ${escapeHTML(mutualsLabel)} mutual follow${item.criteria.mutualsCount === 1 ? '' : 's'} in common with you on Bluesky">${escapeHTML(mutualsLabel)} ${mutualWord}</span>`;
      }

      if (warningsCount === 0) {
        badgesHTML =
          '<span class="badge badge-success" title="Meets all positive criteria checks">OK</span>';
      }

      const isLocked = state.lockedDids.has(item.did);
      if (isLocked) {
        badgesHTML =
          '<span class="badge badge-locked" title="Protected: This account is locked and excluded from Select All and unfollowing">🔒 LOCKED</span>' +
          badgesHTML;
      }

      // Score color class (0-5 scale: high score represents strong reason to unfollow)
      let scoreClass = 'score-high';
      if (item.score >= 4) scoreClass = 'score-low';
      else if (item.score >= 2) scoreClass = 'score-mid';

      const defaultAvatar =
        "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 24 24' fill='%23cbd5e1'><circle cx='12' cy='12' r='12'/></svg>";
      const avatarSrc = item.avatar ? sanitizeUrl(item.avatar, defaultAvatar) : defaultAvatar;
      const safeDid = escapeHTML(item.did);
      const safeHandle = escapeHTML(item.handle);
      const safeLabelName = escapeHTML(item.displayName || item.handle);

      const isUnfollowed = !item.followingUri;
      if (isUnfollowed) {
        row.classList.add('unfollowed-row');
      } else if (isLocked) {
        row.classList.add('locked-row');
      } else if (state.selectedDids.has(item.did)) {
        row.classList.add('selected-row');
      }

      const isLowFollowers = item.criteria.followersCount < state.params.lowFollowersThreshold;
      const isPostInactive = item.neverPosted || item.dynamicInactive;

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
      const relativeDateStr = escapeHTML(formatRelativeDate(renderDate));

      let cellContentHTML = relativeDateStr;
      if (renderDate && relativeDateStr !== 'Never') {
        let typeLabel = '';
        const safeType = escapeHTML(interactionInfo?.type || '');
        if (interactionInfo?.type) {
          const typeMap = {
            like: 'Like',
            reply: 'Reply',
            repost: 'Repost',
            message: 'DM',
          };
          typeLabel = ` (${escapeHTML(typeMap[interactionInfo.type] || interactionInfo.type)})`;
        }

        const safeLinkUrl = sanitizeUrl(interactionInfo?.link, '');
        if (safeLinkUrl) {
          cellContentHTML = `<a href="${safeLinkUrl}" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;" title="View last ${safeType} on Bluesky">${relativeDateStr}${typeLabel}</a>`;
        } else {
          cellContentHTML = `${relativeDateStr}${typeLabel}`;
        }
      }

      const displayNameHTML = truncateText(item.displayName || item.handle.split('.')[0], 16);
      const handleHTML = truncateText('@' + item.handle, 20);

      let checkboxHTML;
      if (isUnfollowed) {
        checkboxHTML =
          '<span class="text-muted text-center" style="display: block; opacity: 0.5;">—</span>';
      } else {
        const checkedAttr = !isLocked && state.selectedDids.has(item.did) ? 'checked' : '';
        const disabledAttr = isLocked ? 'disabled' : '';
        const checkboxLabel = isLocked
          ? `Account ${safeLabelName} is locked`
          : `Select ${safeLabelName} for batch actions`;
        const lockTitle = isLocked
          ? 'Unlock account (allow selection and unfollowing)'
          : 'Lock account (protect from Select All and unfollowing)';
        const lockActionLabel = `${isLocked ? 'Unlock' : 'Lock'} ${safeLabelName}`;

        checkboxHTML = `
          <div class="cell-controls">
            <input type="checkbox" class="row-checkbox" data-did="${safeDid}" ${checkedAttr} ${disabledAttr} aria-label="${checkboxLabel}">
            <button type="button" class="lock-toggle-btn ${isLocked ? 'is-locked' : ''}" data-did="${safeDid}" title="${lockTitle}" aria-label="${lockActionLabel}" aria-pressed="${isLocked}">${isLocked ? '🔒' : '🔓'}</button>
          </div>
        `;
      }

      const unfollowDisabledAttr = isLocked ? 'disabled title="Unlock account to unfollow"' : '';
      let actionButtonHTML;
      if (isUnfollowed) {
        actionButtonHTML = `<button class="btn btn-primary btn-sm refollow-single-btn" data-did="${safeDid}" data-handle="${safeHandle}" aria-label="Re-follow ${safeLabelName}">Re-follow</button>`;
      } else {
        actionButtonHTML = `<button class="btn btn-secondary btn-sm unfollow-single-btn" data-did="${safeDid}" data-handle="${safeHandle}" ${unfollowDisabledAttr} aria-label="Unfollow ${safeLabelName}">Unfollow</button>`;
      }

      row.innerHTML = `
        <td class="col-checkbox">
          ${checkboxHTML}
        </td>
        <td class="col-profile">
          <div class="profile-cell" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">
            <a href="https://bsky.app/profile/${encodeURIComponent(item.handle)}" target="_blank" rel="noopener noreferrer" class="profile-link">
              <img class="avatar" src="${avatarSrc}" alt="${safeHandle}" loading="lazy">
              <div class="profile-info">
                <span class="display-name">${displayNameHTML}</span>
                <span class="handle">${handleHTML}</span>
              </div>
            </a>
          </div>
        </td>
        <td class="col-meta col-followers ${isLowFollowers ? 'criteria-highlight' : ''}" data-label="Followers" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${item.criteria.followersCount.toLocaleString()}</td>
        <td class="col-meta col-last-post ${isPostInactive ? 'criteria-highlight' : ''}" data-label="Last post" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${escapeHTML(formatRelativeDate(item.criteria.lastPostDate))}</td>
        <td class="col-meta col-last-interaction ${isInteractionInactive ? 'criteria-highlight' : ''}" data-label="Last interaction" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${cellContentHTML}</td>
        <td class="col-flags" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">
          <div class="flags-list">${isUnfollowed ? '<span class="badge badge-secondary">Unfollowed</span>' : badgesHTML}</div>
        </td>
        <td class="col-score score-cell ${scoreClass}" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${escapeHTML(item.score)}</td>
        <td class="col-action text-right">
          ${actionButtonHTML}
        </td>
      `;

      if (isUnfollowed) {
        row.querySelector('.refollow-single-btn').addEventListener('click', async (e) => {
          const did = e.target.dataset.did;
          const handle = e.target.dataset.handle;
          await handleRefollow(did, handle, e.target);
        });
      } else {
        const lockBtn = row.querySelector('.lock-toggle-btn');
        if (lockBtn) {
          lockBtn.addEventListener('click', async () => {
            if (state.lockedDids.has(item.did)) {
              state.lockedDids.delete(item.did);
            } else {
              state.lockedDids.add(item.did);
              state.selectedDids.delete(item.did);
            }
            if (state.user) {
              await syncCache.setLockedDids(state.user.did, Array.from(state.lockedDids));
            }
            renderDashboard(false);
          });
        }

        row.querySelector('.row-checkbox').addEventListener('change', (e) => {
          if (state.lockedDids.has(item.did)) return;
          if (e.target.checked) {
            state.selectedDids.add(item.did);
          } else {
            state.selectedDids.delete(item.did);
          }
          updateSelectedCounter();
          renderCheckboxHeaders(pageItems);
        });

        row.querySelector('.unfollow-single-btn').addEventListener('click', async (e) => {
          if (state.lockedDids.has(item.did)) return;
          const did = e.target.dataset.did;
          await executeUnfollow([did], e.target);
        });
      }

      const profileCell = row.querySelector('.profile-cell');
      if (profileCell && hoverCard) {
        profileCell.addEventListener('mouseenter', () => {
          clearTimeout(hoverHideTimeout);
          clearTimeout(hoverShowTimeout);
          hoverShowTimeout = setTimeout(() => {
            showHoverCard(item, profileCell);
          }, 180);
        });
        profileCell.addEventListener('mouseleave', () => {
          clearTimeout(hoverShowTimeout);
          scheduleHideHoverCard();
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
  const selectableItems = pageItems.filter(
    (item) => Boolean(item.followingUri) && !state.lockedDids.has(item.did),
  );
  if (selectableItems.length === 0) {
    selectAllCheckbox.checked = false;
    selectAllCheckbox.disabled = true;
    return;
  }
  selectAllCheckbox.disabled = false;
  const allPageDidsSelected = selectableItems.every((item) => state.selectedDids.has(item.did));
  selectAllCheckbox.checked = allPageDidsSelected;
}

function handleSelectAllToggle(e) {
  const list = getFilteredAndSortedList();
  const startIdx = (state.pagination.currentPage - 1) * state.pagination.pageSize;
  const endIdx = Math.min(startIdx + state.pagination.pageSize, list.length);
  const selectableItems = list
    .slice(startIdx, endIdx)
    .filter((item) => Boolean(item.followingUri) && !state.lockedDids.has(item.did));

  if (e.target.checked) {
    selectableItems.forEach((item) => state.selectedDids.add(item.did));
  } else {
    selectableItems.forEach((item) => state.selectedDids.delete(item.did));
  }
  renderDashboard(false);
}

function updateSelectedCounter() {
  const count = state.selectedDids.size;
  selectedCountSpan.textContent = count;
  if (!batchUnfollowBtn.contains(selectedCountSpan)) {
    batchUnfollowBtn.replaceChildren('Unfollow Selected (', selectedCountSpan, ')');
  }
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
  const unlockedDids = dids.filter((did) => !state.lockedDids.has(did));
  if (unlockedDids.length === 0) return;

  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.textContent = 'unfollowing...';
  }

  if (!buttonEl && unlockedDids.length > 0) {
    batchUnfollowBtn.disabled = true;
    batchUnfollowBtn.textContent = 'Unfollowing...';
  }

  try {
    const data = await batchUnfollow(state.agent, state.user.did, unlockedDids, onSyncUpdate);

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
function hideLoading() {
  if (appLoadingSection) {
    appLoadingSection.classList.add('hidden');
  }
}

function showAuthSection() {
  hideLoading();
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
  hideLoading();
  authSection.classList.add('hidden');
  dashboardSection.classList.add('hidden');
  syncSection.classList.remove('hidden');
  syncError.classList.add('hidden');
  cancelSyncBtn.classList.remove('hidden');
  retrySyncBtn.classList.add('hidden');
  updateSyncProgressUI(syncState);
}

function showSyncError(errMessage) {
  hideLoading();
  syncSection.classList.remove('hidden');
  syncStage.textContent = 'Sync Failed';
  syncPercent.textContent = '';
  syncError.textContent = errMessage;
  syncError.classList.remove('hidden');
  cancelSyncBtn.classList.add('hidden');
  retrySyncBtn.classList.remove('hidden');
}

function showSyncCancelled(errMessage) {
  hideLoading();
  syncSection.classList.remove('hidden');
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

// --- Singleton Rich Hover Card Logic ---
function scheduleHideHoverCard() {
  clearTimeout(hoverHideTimeout);
  hoverHideTimeout = setTimeout(() => {
    hideHoverCardImmediately();
  }, 150);
}

function hideHoverCardImmediately() {
  clearTimeout(hoverShowTimeout);
  clearTimeout(hoverHideTimeout);
  activeHoverDid = null;
  if (hoverCard) {
    hoverCard.classList.add('hidden');
  }
}

function positionHoverCard(anchorEl) {
  if (!hoverCard || !anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const cardWidth = 340;
  const cardHeight = hoverCard.offsetHeight || 240;
  const margin = 10;

  // Prefer placing to the right of the profile cell; fallback to aligned left below/above
  let left = rect.right + margin;
  if (left + cardWidth > window.innerWidth - margin) {
    left = Math.max(margin, rect.left);
  }

  let top = rect.top - 8;
  if (top + cardHeight > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - cardHeight - margin);
  }

  hoverCard.style.left = `${Math.round(left)}px`;
  hoverCard.style.top = `${Math.round(top)}px`;
}

function formatMutualsCount(criteria) {
  const count = criteria?.mutualsCount || 0;
  const isTenPlus = count > 10 || (count === 10 && criteria?.hasMoreMutuals !== false);
  return isTenPlus ? '10+' : `${count}`;
}

function renderHoverCardHTML(item, isHydrating = false) {
  const defaultAvatar =
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='36' height='36' viewBox='0 0 24 24' fill='%23cbd5e1'><circle cx='12' cy='12' r='12'/></svg>";
  const avatarSrc = item.avatar ? sanitizeUrl(item.avatar, defaultAvatar) : defaultAvatar;
  const safeName = escapeHTML(item.displayName || item.handle);
  const safeHandle = escapeHTML(item.handle);
  const profileUrl = `https://bsky.app/profile/${encodeURIComponent(item.handle)}`;

  const followsBadge = item.criteria?.isFollowingUser
    ? '<span class="badge badge-success">FOLLOWS YOU</span>'
    : '<span class="badge badge-secondary">DOES NOT FOLLOW</span>';

  const followersStr = (item.criteria?.followersCount || 0).toLocaleString();
  const followsStr = (item.criteria?.followsCount || 0).toLocaleString();
  const postsStr = (item.criteria?.postsCount || 0).toLocaleString();

  // 1. Bio section
  let bioHTML;
  if (isHydrating && !item.description) {
    bioHTML = '<div class="hover-card-bio empty">Loading profile details...</div>';
  } else if (item.description && item.description.trim()) {
    bioHTML = `<div class="hover-card-bio">${escapeHTML(item.description.trim())}</div>`;
  } else {
    bioHTML = '<div class="hover-card-bio empty">No bio provided</div>';
  }

  // 2. Common Followers (Mutuals) section
  const mutualsCount = item.criteria?.mutualsCount || 0;
  const mutualsLabel = formatMutualsCount(item.criteria);
  const isTenPlus = mutualsLabel === '10+';
  const mutualsList = item.preview?.mutuals || [];
  let mutualsHTML;
  if (mutualsCount > 0 || mutualsList.length > 0) {
    const avatarsHTML = mutualsList
      .slice(0, 4)
      .map((m) => {
        const mAvatar = m.avatar ? sanitizeUrl(m.avatar, defaultAvatar) : defaultAvatar;
        return `<img src="${mAvatar}" alt="${escapeHTML(m.handle)}" loading="lazy">`;
      })
      .join('');

    const names = mutualsList.slice(0, 2).map((m) => `@${escapeHTML(m.handle)}`);
    const baseCount = Math.min(mutualsCount, 10);
    const extraCount = Math.max(0, baseCount - names.length);
    const extraSuffix = isTenPlus ? '+' : '';
    let summaryText;
    if (names.length > 0) {
      summaryText = `Followed by ${names.join(', ')}`;
      if (extraCount > 0) {
        summaryText += ` + ${extraCount}${extraSuffix} other${extraCount > 1 ? 's' : ''} you follow`;
      }
    } else {
      summaryText = `Followed by ${mutualsLabel} account${mutualsCount === 1 ? '' : 's'} you follow`;
    }

    mutualsHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label">
          <span>Common Followers</span>
          <span>${mutualsLabel} mutual${mutualsCount === 1 ? '' : 's'}</span>
        </div>
        <div class="hover-card-mutuals">
          ${avatarsHTML ? `<div class="hover-card-mutual-avatars">${avatarsHTML}</div>` : ''}
          <span>${summaryText}</span>
        </div>
      </div>
    `;
  } else {
    mutualsHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label"><span>Common Followers</span><span>0 mutuals</span></div>
        <div class="hover-card-mutuals"><span>No mutual followers in common</span></div>
      </div>
    `;
  }

  // 3. Most Recent Post section
  const lastPost = item.preview?.lastPost;
  const lastPostDateStr = escapeHTML(
    formatRelativeDate(lastPost?.date || item.criteria?.lastPostDate),
  );
  let postHTML;
  if (lastPost && lastPost.text) {
    const safePostUrl = sanitizeUrl(lastPost.uri, profileUrl);
    const likes = (lastPost.likeCount || 0).toLocaleString();
    const reposts = (lastPost.repostCount || 0).toLocaleString();
    postHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label">
          <span>Most Recent Post</span>
          <span>${lastPostDateStr}</span>
        </div>
        <div class="hover-card-post">
          <div class="hover-card-post-text">${escapeHTML(lastPost.text)}</div>
          <div class="hover-card-post-meta">
            <span>♥ ${likes} · ↻ ${reposts}</span>
            <a href="${safePostUrl}" target="_blank" rel="noopener noreferrer">View post ↗</a>
          </div>
        </div>
      </div>
    `;
  } else if (item.criteria?.lastPostDate) {
    postHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label">
          <span>Most Recent Post</span>
          <span>${lastPostDateStr}</span>
        </div>
        <div class="hover-card-post-meta">
          <span>${isHydrating ? 'Fetching post snippet...' : 'Media/repost or no text content'}</span>
          <a href="${profileUrl}" target="_blank" rel="noopener noreferrer">View feed ↗</a>
        </div>
      </div>
    `;
  } else {
    postHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label"><span>Most Recent Post</span><span>Never</span></div>
        <div class="hover-card-mutuals"><span>No public posts found</span></div>
      </div>
    `;
  }

  return `
    <div class="hover-card-header">
      <img class="hover-card-avatar" src="${avatarSrc}" alt="${safeHandle}">
      <div class="hover-card-identity">
        <div class="hover-card-name-row">
          <a href="${profileUrl}" target="_blank" rel="noopener noreferrer" class="hover-card-name">${safeName}</a>
          ${followsBadge}
        </div>
        <span class="hover-card-handle">@${safeHandle}</span>
      </div>
    </div>
    <div class="hover-card-stats">
      <span><strong>${followersStr}</strong> Followers</span>
      <span><strong>${followsStr}</strong> Following</span>
      <span><strong>${postsStr}</strong> Posts</span>
    </div>
    ${bioHTML}
    ${mutualsHTML}
    ${postHTML}
  `;
}

async function showHoverCard(item, anchorEl) {
  if (!hoverCard) return;
  activeHoverDid = item.did;

  const rawItem = state.followings.find((f) => f.did === item.did) || item;
  const needsHydration =
    rawItem.description === undefined &&
    (!rawItem.preview ||
      (!rawItem.preview.lastPost &&
        (!rawItem.preview.mutuals || rawItem.preview.mutuals.length === 0)));

  hoverCard.innerHTML = renderHoverCardHTML(rawItem, needsHydration);
  hoverCard.classList.remove('hidden');
  positionHoverCard(anchorEl);

  if (needsHydration && state.agent && state.user) {
    try {
      const enriched = await fetchAccountPreview(state.agent, state.user.did, rawItem.did);
      rawItem.description = enriched.description;
      rawItem.preview = enriched.preview;
      if (enriched.mutualsCount !== undefined && rawItem.criteria) {
        rawItem.criteria.mutualsCount = enriched.mutualsCount;
        rawItem.criteria.hasMoreMutuals = enriched.hasMoreMutuals;
      }
      if (activeHoverDid === rawItem.did && !hoverCard.classList.contains('hidden')) {
        hoverCard.innerHTML = renderHoverCardHTML(rawItem, false);
        positionHoverCard(anchorEl);
      }
    } catch (err) {
      console.warn('Could not lazily hydrate hover preview:', err);
    }
  }
}
