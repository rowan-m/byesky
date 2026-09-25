import { initOAuthClient } from './auth.js';
import { describeScopes, getMissingScopes, hasLegacyBroadScopes } from './scopes.js';
import { syncCache } from './cache.js';
import {
  clampParam,
  filterAndSortFollowings,
  UNKNOWN_SOURCE_LABELS,
  escapeHTML,
  sanitizeUrl,
  truncateText,
} from './scoring.js';

// Keep in step with SCAN_LIMIT in atproto.js (not imported so the API bundle stays lazy).
const SCAN_LIMIT_LABEL = '2,500';

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
  missingScopes: [], // Required OAuth scopes this session wasn't granted (see scopes.js)
  hasLegacyScopes: false, // Session still holds broad scopes from before granular permissions
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
const syncStepTitle = document.getElementById('sync-step-title');
const syncProgressTrack = document.getElementById('sync-progress-track');
const syncEta = document.getElementById('sync-eta');
const skipMutualsPanel = document.getElementById('skip-mutuals');
const skipMutualsBtn = document.getElementById('skip-mutuals-btn');
const syncElsewhere = document.getElementById('sync-elsewhere');
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

// @atproto/api is ~80% of the bundle and only needed once signed in, so it's loaded on demand.
let atprotoApi = null;
async function loadAtprotoApi() {
  atprotoApi ??= await import('./atproto.js');
  return atprotoApi;
}

// Hint (not a credential) that a session probably exists, so the API chunk can be
// fetched in parallel with OAuth session restore instead of after it.
const SESSION_HINT_KEY = 'byesky:hasSession';
function setSessionHint(hasSession) {
  try {
    if (hasSession) localStorage.setItem(SESSION_HINT_KEY, '1');
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Storage unavailable; we just lose the preload optimisation.
  }
}
function isLikelySignedIn() {
  const isOAuthCallback = /[?#&](code|state)=/.test(window.location.search + window.location.hash);
  try {
    return isOAuthCallback || localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return isOAuthCallback;
  }
}

// --- Initialization ---
window.addEventListener('DOMContentLoaded', async () => {
  // Conforms with RFC 8252 loopback IP policies (which prohibit "localhost" hostnames)
  if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
    return;
  }
  // OAuth client metadata is published for the *.web.app hostname, so sign-in only works
  // there. Send visitors on the equivalent *.firebaseapp.com hostname across.
  if (window.location.hostname.endsWith('.firebaseapp.com')) {
    const url = new URL(window.location.href);
    url.hostname = url.hostname.replace(/\.firebaseapp\.com$/, '.web.app');
    window.location.replace(url.href);
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

  // Re-authorise when the session is missing newly required scopes
  document.getElementById('reauth-btn')?.addEventListener('click', handleReauth);

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
  const paramInputs = {
    'param-inactive-days': 'inactiveDays',
    'param-low-followers': 'lowFollowersThreshold',
    'param-noisy-posts': 'noisyPostsThreshold',
    'param-mass-follower': 'massFollowerThreshold',
  };
  for (const [id, key] of Object.entries(paramInputs)) {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
      // Leave an empty or half-typed field alone; clamp when it's a number.
      if (input.value.trim() === '') return;
      state.params[key] = clampParam(key, input.value);
      renderDashboard();
    });
    input.addEventListener('change', () => {
      state.params[key] = clampParam(key, input.value);
      input.value = String(state.params[key]);
      renderDashboard();
    });
  }

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
  skipMutualsBtn?.addEventListener('click', handleSkipMutuals);

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

  // Preview sheet (touch / keyboard): close via button or a tap on the ::backdrop,
  // which targets the <dialog> element itself rather than its content.
  const previewSheet = document.getElementById('preview-sheet');
  if (previewSheet) {
    previewSheet
      .querySelector('.preview-sheet-close')
      ?.addEventListener('click', () => previewSheet.close());
    previewSheet.addEventListener('click', (e) => {
      if (e.target === previewSheet) previewSheet.close();
    });
  }
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

// Page regions made inert while the narrow-screen sheet is open (modal behaviour).
const CONFIG_OVERLAY_INERT_SELECTORS = ['.app-header', '.dashboard-main', '.app-footer'];

function setConfigOverlay(overlay) {
  const panel = document.getElementById('config-panel');
  const backdrop = document.getElementById('config-backdrop');
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
  if (backdrop) backdrop.hidden = !overlay;

  if (panel) {
    if (overlay) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'Criteria & Scoring');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      panel.removeAttribute('aria-label');
    }
  }
  CONFIG_OVERLAY_INERT_SELECTORS.forEach((selector) => {
    document.querySelector(selector)?.toggleAttribute('inert', overlay);
  });
}

function setConfigCollapsed(collapsed) {
  // Measure before toggling classes so the sheet is anchored to the collapsed bar.
  setConfigOverlay(narrowLayoutQuery.matches && !collapsed);
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

  const isOverlayOpen = () =>
    narrowLayoutQuery.matches && !grid.classList.contains('is-config-collapsed');
  const closeOverlay = () => {
    setConfigCollapsed(true);
    toggle.focus();
  };

  toggle.addEventListener('click', () => {
    const collapsed = !grid.classList.contains('is-config-collapsed');
    setConfigCollapsed(collapsed);
    if (!narrowLayoutQuery.matches) storeConfigCollapsed(collapsed);
  });

  // Escape closes the expanded overlay-style panel on narrow screens.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOverlayOpen()) closeOverlay();
  });

  // The backdrop is a real element so taps outside the sheet are absorbed rather than
  // activating whatever is underneath (rows, lock toggles, the batch Unfollow button).
  document.getElementById('config-backdrop')?.addEventListener('click', closeOverlay);

  narrowLayoutQuery.addEventListener('change', applyConfigLayout);

  // Re-anchor the open sheet when the width changes (e.g. rotation). Height-only
  // resizes (mobile browser chrome showing/hiding) are handled by dvh.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (isOverlayOpen()) {
      const body = document.getElementById('config-body');
      const scrollTop = body?.scrollTop ?? 0;
      grid.classList.add('is-config-collapsed');
      setConfigOverlay(true);
      grid.classList.remove('is-config-collapsed');
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

  // Expose the panel's height so, on wide screens, a panel taller than the window sticks
  // with its bottom in view instead of needing its own scrollbar.
  const panel = document.getElementById('config-panel');
  if (panel && 'ResizeObserver' in window) {
    new window.ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--sidebar-h', `${height}px`);
    }).observe(panel);
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

  state.params.inactiveDays = clampParam(
    'inactiveDays',
    document.getElementById('param-inactive-days').value,
  );
  state.params.lowFollowersThreshold = clampParam(
    'lowFollowersThreshold',
    document.getElementById('param-low-followers').value,
  );
  state.params.noisyPostsThreshold = clampParam(
    'noisyPostsThreshold',
    document.getElementById('param-noisy-posts').value,
  );
  state.params.massFollowerThreshold = clampParam(
    'massFollowerThreshold',
    document.getElementById('param-mass-follower').value,
  );
}

// --- Session & Authentication ---
async function checkSession() {
  try {
    if (isLikelySignedIn()) loadAtprotoApi().catch(() => {}); // warm up in parallel
    const oauthClient = initOAuthClient();
    const result = await oauthClient.init();

    if (result && result.session) {
      const api = await loadAtprotoApi();
      setSessionHint(true);
      state.session = result.session;
      state.agent = api.createAgent(result.session);

      state.user = {
        loggedIn: true,
        did: result.session.did,
        handle: await resolveOwnHandle(api, result.session.did),
      };

      showUserSession(state.user.handle);
      const missingScopes = await checkGrantedScopes(result.session);
      // Returning from "Sign in again": resync so the newly granted data is included.
      if (consumeResyncAfterReauth() && missingScopes.length === 0) {
        await triggerSync();
      } else {
        await checkSyncStatus();
      }
    } else {
      setSessionHint(false);
      state.user = null;
      showAuthSection();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    state.user = null;
    showAuthSection();
  }
}

/**
 * Looks up the signed-in user's handle for display. A valid session must not be treated as
 * signed out just because the lookup failed (e.g. while Bluesky is rate limiting), so fall
 * back to the authenticated route and finally to the DID.
 */
async function resolveOwnHandle(api, did) {
  try {
    const publicAgent = api.createAgent({ service: 'https://api.bsky.app' });
    return (await publicAgent.app.bsky.actor.getProfile({ actor: did })).data.handle;
  } catch (err) {
    console.warn('Public profile lookup failed, trying via the PDS:', err);
  }
  try {
    const viewer = api.createViewerAgent(state.agent);
    return (await viewer.app.bsky.actor.getProfile({ actor: did })).data.handle;
  } catch (err) {
    console.warn('Could not look up own handle; showing DID instead:', err);
    return did;
  }
}

// --- Granted-scope check ---
// Sessions authorised before the app added a scope keep their original grant until the
// user signs in again, so check what was granted and prompt if anything is missing.
const RESYNC_AFTER_REAUTH_KEY = 'byesky:resyncAfterReauth';

async function checkGrantedScopes(session) {
  let missing = [];
  let legacy = false;
  try {
    const { scope } = await session.getTokenInfo(false);
    missing = getMissingScopes(scope);
    legacy = hasLegacyBroadScopes(scope);
  } catch (err) {
    console.warn('Could not read granted OAuth scopes:', err);
  }
  state.missingScopes = missing;
  state.hasLegacyScopes = legacy;
  renderReauthBanner();
  return missing;
}

function renderReauthBanner(errorMessage = '') {
  const banner = document.getElementById('reauth-banner');
  const detail = document.getElementById('reauth-banner-detail');
  if (!banner || !detail) return;

  const missing = state.user ? state.missingScopes : [];
  banner.classList.toggle('hidden', missing.length === 0);
  if (missing.length === 0) return;

  const purposes = describeScopes(missing).join(' and ');
  const title = document.getElementById('reauth-banner-title');
  if (title) {
    title.textContent = state.hasLegacyScopes
      ? 'ByeSky has narrowed its permissions.'
      : 'ByeSky needs an extra permission.';
  }
  const message = state.hasLegacyScopes
    ? 'It now asks only for what it needs instead of broad access to your account. Sign in again to switch; until then some results may be incomplete.'
    : `Sign in again to allow it to ${purposes}. Syncing still works, but results will be incomplete until you do.`;
  detail.textContent = errorMessage || message;
}

function consumeResyncAfterReauth() {
  try {
    const pending = sessionStorage.getItem(RESYNC_AFTER_REAUTH_KEY) === '1';
    sessionStorage.removeItem(RESYNC_AFTER_REAUTH_KEY);
    return pending;
  } catch {
    return false;
  }
}

async function handleReauth() {
  if (!state.user) return;
  try {
    sessionStorage.setItem(RESYNC_AFTER_REAUTH_KEY, '1');
  } catch {
    // Without storage we just skip the automatic resync after returning.
  }
  try {
    // Redirects to the user's PDS, which asks them to approve the full, current scope set.
    await initOAuthClient().signIn(state.user.handle);
  } catch (err) {
    renderReauthBanner(`Couldn't start sign-in: ${err.message || err}. Please try again.`);
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
  if (state.user) atprotoApi?.cancelSync?.(state.user.did);
  if (state.user && state.session) {
    try {
      await state.session.signOut();
    } catch (err) {
      console.warn('Signout error:', err);
    }
    await syncCache.clear(state.user.did);
  }

  setSessionHint(false);
  state.user = null;
  state.session = null;
  state.agent = null;
  state.missingScopes = [];
  renderReauthBanner();
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

    renderLastSynced(cachedState);

    if (cachedState.status === 'idle') {
      await triggerSync();
    } else if (cachedState.status === 'fetching' || cachedState.status === 'enriching') {
      showSyncSection(cachedState);
      // Restart background sync in browser and attach update callback
      atprotoApi.startBackgroundSync(state.agent, state.user.did, onSyncUpdate);
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
  etaSample = null;

  // Replaces (and waits for) any run already going in this tab; see startBackgroundSync.
  atprotoApi.startBackgroundSync(state.agent, state.user.did, onSyncUpdate);
  showSyncSection({ status: 'fetching', progress: {} });
}

/**
 * Event-driven callback executed by atproto.js background sync loops.
 * Avoids browser CPU polling loops.
 */
let syncUpdateFrame = null;

function onSyncUpdate() {
  // Syncs report progress many times a second. Render at most once per frame, and not at
  // all while the tab is in the background (frames don't fire), catching up on return.
  if (syncUpdateFrame !== null) return;
  syncUpdateFrame = requestAnimationFrame(() => {
    syncUpdateFrame = null;
    applySyncUpdate();
  });
}

async function applySyncUpdate() {
  if (!state.user) return;
  const did = state.user.did;

  try {
    const cachedState = await syncCache.get(did);
    if (!state.user || state.user.did !== did) return; // signed out meanwhile
    state.sync = cachedState;
    renderLastSynced(cachedState);

    if (cachedState.status === 'completed') {
      await loadFollowings();
    } else if (cachedState.status === 'cancelled') {
      showSyncCancelled(cachedState.error || 'Sync cancelled by user.');
    } else if (cachedState.status === 'error') {
      showSyncError(cachedState.error);
    } else {
      updateSyncProgressUI(cachedState);
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
function formatCount(n) {
  return typeof n === 'number' ? n.toLocaleString() : '—';
}

function badge(kind, title, label) {
  return `<span class="badge badge-${kind}" title="${escapeHTML(title)}">${escapeHTML(label)}</span>`;
}

/**
 * Criteria badges for a row, driven by the same evaluation as the score and filters so the
 * OK badge and the OK filter always agree.
 */
function renderCriteriaBadges(item) {
  const m = item.evaluation.matches;
  const c = item.criteria;
  const out = [];

  if (item.isOk) {
    out.push(badge('success', 'Nothing with a weight above 0 matches this account', 'OK'));
  } else {
    if (c.isDeleted)
      out.push(badge('danger', 'This account has been deleted or deactivated', 'DELETED'));
    if (c.isBanned)
      out.push(badge('danger', 'This account has been taken down by Bluesky', 'BANNED'));
    if (m.blocking) {
      const title = c.isBlocked ? 'This account blocks you' : 'You block this account';
      out.push(badge('danger', title, 'BLOCK'));
    }
    if (m.neverPosted) {
      out.push(
        badge(
          'warning',
          'Never Posted: No posts, replies or reposts found for this account',
          'NEVER POSTED',
        ),
      );
    } else if (m.inactive) {
      out.push(
        badge(
          'warning',
          `Inactive: No posts, replies or reposts in the last ${state.params.inactiveDays} days`,
          'INACTIVE',
        ),
      );
    }
    if (m.notFollowing)
      out.push(badge('secondary', 'This account does not follow you back', 'NO FOLLOW'));
    if (m.noInbound) {
      out.push(
        badge(
          'secondary',
          `They have not liked, reposted, replied, quoted or messaged you recently (scanned your last ${SCAN_LIMIT_LABEL} notifications)`,
          'NO INBOUND',
        ),
      );
    }
    if (m.noOutbound) {
      out.push(
        badge(
          'secondary',
          `You have not liked, replied to, reposted, quoted or messaged them recently (scanned your last ${SCAN_LIMIT_LABEL} posts and likes)`,
          'NO OUTBOUND',
        ),
      );
    }
    if (m.noisy) {
      out.push(
        badge(
          'warning',
          `Noisy Poster: ${c.postsCount7Days ?? 'Many'} posts, replies and reposts in the last 7 days`,
          'NOISY',
        ),
      );
    }
    if (m.muted)
      out.push(badge('danger', 'Muted: You have muted this account on Bluesky', 'MUTED'));
    if (m.massFollower) {
      out.push(
        badge(
          'warning',
          `Mass Follower: Follows ${formatCount(c.followsCount)} accounts on Bluesky`,
          'MASS FOLLOW',
        ),
      );
    }
    if (m.spammyRatio) {
      out.push(
        badge(
          'danger',
          'Spammy Ratio: Follows far more accounts than follow it (follow-back farmer)',
          'SPAMMY RATIO',
        ),
      );
    }
    if (m.flagged)
      out.push(
        badge('danger', 'Flagged: This account has moderation labels from Bluesky', 'FLAGGED'),
      );
    if (m.lowFollowers) {
      out.push(
        badge(
          'secondary',
          `Low Followers: Fewer than ${state.params.lowFollowersThreshold} followers`,
          'LOW FOLLOWERS',
        ),
      );
    }
    if (m.outlier)
      out.push(
        badge(
          'warning',
          'Social Outlier: None of the accounts you follow follow them',
          '0 MUTUALS',
        ),
      );
  }

  // Positive signals are shown either way.
  if (item.evaluation.hasInbound) {
    out.push(
      badge(
        'success',
        `They liked, reposted, replied, quoted or messaged you recently (scanned your last ${SCAN_LIMIT_LABEL} notifications)`,
        'THEY CONTACTED',
      ),
    );
  }
  if (item.evaluation.hasOutbound) {
    out.push(
      badge(
        'success',
        `You liked, replied to, reposted, quoted or messaged them recently (scanned your last ${SCAN_LIMIT_LABEL} posts and likes)`,
        'I CONTACTED',
      ),
    );
  }
  if (typeof c.mutualsCount === 'number' && c.mutualsCount > 0) {
    const label = formatMutualsCount(c);
    const word = c.mutualsCount === 1 ? 'MUTUAL' : 'MUTUALS';
    out.push(
      badge('success', `${label} of the accounts you follow also follow them`, `${label} ${word}`),
    );
  }

  const missing = item.evaluation.unknownSources;
  if (missing.length > 0) {
    const what = missing.map((s) => UNKNOWN_SOURCE_LABELS[s]).join(', ');
    out.push(
      badge(
        'info',
        `Couldn't fetch ${what} for this account, so criteria that depend on it are skipped. Resync to try again.`,
        'INCOMPLETE',
      ),
    );
  }

  return out.join('');
}

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

      let badgesHTML;
      badgesHTML = renderCriteriaBadges(item);

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

      const isLowFollowers = item.evaluation.matches.lowFollowers === true;
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
            quote: 'Quote',
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
            <button type="button" class="preview-btn" aria-label="Preview @${safeHandle}" aria-haspopup="dialog">ⓘ</button>
          </div>
        </td>
        <td class="col-meta col-followers ${isLowFollowers ? 'criteria-highlight' : ''}" data-label="Followers" style="${isUnfollowed ? 'opacity: 0.5;' : ''}">${escapeHTML(formatCount(item.criteria.followersCount))}</td>
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
      row.querySelector('.preview-btn')?.addEventListener('click', () => {
        hideHoverCardImmediately();
        showPreviewSheet(item);
      });
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
    const data = await atprotoApi.batchUnfollow(
      state.agent,
      state.user.did,
      unlockedDids,
      onSyncUpdate,
    );

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
    const data = await atprotoApi.followUser(state.agent, state.user.did, did, onSyncUpdate);

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
  skipMutualsPanel?.classList.add('hidden');
  syncEta?.classList.add('hidden');
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
  skipMutualsPanel?.classList.add('hidden');
  syncEta?.classList.add('hidden');
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
    atprotoApi.cancelSync(state.user.did);
    await syncCache.set(state.user.did, {
      status: 'cancelled',
      error: 'Synchronization aborted by user.',
    });
    await syncCache.flush(state.user.did);
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

// Tracks progress within the current step to estimate the time remaining.
let etaSample = null;

function updateSyncProgressUI(syncState) {
  const { progress = {} } = syncState;
  const step = progress.step;
  const skipped = Boolean(syncState.skipMutuals);

  if (step) {
    const label = step.id === 'activity' && skipped ? 'Checking recent activity' : step.label || '';
    const count = document.createElement('span');
    count.className = 'sync-step-count';
    count.textContent = `Step ${step.index} of ${step.total}:`;
    syncStepTitle.replaceChildren(count, ' ', label);
  } else {
    syncStepTitle.textContent = 'Starting sync…';
  }

  syncStage.textContent = progress.currentStage || 'Syncing...';

  let percent = 0;
  if (progress.total > 0) {
    percent = Math.round((progress.processed / progress.total) * 100);
  }
  percent = Math.max(0, Math.min(100, percent));
  syncProgressBar.style.width = `${percent}%`;
  syncPercent.textContent = `${percent}%`;
  syncProgressTrack?.setAttribute('aria-valuenow', String(percent));
  syncProgressTrack?.setAttribute(
    'aria-valuetext',
    step ? `Step ${step.index} of ${step.total}, ${percent}%` : `${percent}%`,
  );

  // Another tab is running this sync; this tab only mirrors it, so it can't skip or cancel.
  const elsewhere = Boolean(syncState.runningElsewhere);
  syncElsewhere?.classList.toggle('hidden', !elsewhere);
  cancelSyncBtn.classList.toggle('hidden', elsewhere);

  const inActivityStep = step?.id === 'activity' && syncState.status === 'enriching';
  skipMutualsPanel?.classList.toggle('hidden', !inActivityStep || skipped || elsewhere);
  updateSyncEta(step, progress);
}

function updateSyncEta(step, progress) {
  if (!syncEta) return;
  const isLongStep = step && (step.id === 'activity' || step.id === 'profiles');
  if (!isLongStep || !progress.total || progress.total <= 0) {
    etaSample = null;
    syncEta.classList.add('hidden');
    return;
  }

  const now = Date.now();
  if (!etaSample || etaSample.stepId !== step.id || progress.processed < etaSample.processed) {
    etaSample = { stepId: step.id, time: now, processed: progress.processed };
    syncEta.classList.add('hidden');
    return;
  }

  const done = progress.processed - etaSample.processed;
  const elapsed = now - etaSample.time;
  if (done < 10 || elapsed < 5000) return; // wait for a stable rate
  const remainingMs = ((progress.total - progress.processed) / done) * elapsed;
  const minutes = Math.round(remainingMs / 60000);
  let text = 'Less than a minute left in this step';
  if (minutes >= 2) text = `About ${minutes} minutes left in this step`;
  else if (minutes === 1) text = 'About a minute left in this step';
  syncEta.textContent = text;
  syncEta.classList.remove('hidden');
}

async function handleSkipMutuals() {
  if (!state.user) return;
  skipMutualsBtn.disabled = true;
  try {
    await syncCache.set(state.user.did, { skipMutuals: true });
    etaSample = null; // the rate is about to change
    updateSyncProgressUI(await syncCache.get(state.user.did));
  } finally {
    skipMutualsBtn.disabled = false;
  }
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

// "Last synced" is when a sync last finished. Entries from before completedAt existed fall
// back to their last write, which is only meaningful once the sync completed.
function renderLastSynced(entry) {
  const at = entry.completedAt ?? (entry.status === 'completed' ? entry.lastUpdated : null);
  lastSyncedTime.textContent = at ? formatLastSynced(at) : '';
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
  } else if (item.criteria?.mutualsCount === undefined) {
    const status = isHydrating ? 'Loading common followers...' : 'Not checked yet';
    mutualsHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label"><span>Common Followers</span></div>
        <div class="hover-card-mutuals"><span>${status}</span></div>
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

  // 3. Latest activity section (posts, replies and reposts all count as activity)
  const lastPost = item.preview?.lastPost;
  const lastPostDateStr = escapeHTML(
    formatRelativeDate(lastPost?.date || item.criteria?.lastPostDate),
  );
  const activityLabels = { post: 'Latest Post', reply: 'Latest Reply', repost: 'Latest Repost' };
  const activityLabel = activityLabels[lastPost?.kind] || 'Latest Activity';
  let postHTML;
  if (lastPost && lastPost.text) {
    const safePostUrl = sanitizeUrl(lastPost.uri, profileUrl);
    const likes = (lastPost.likeCount || 0).toLocaleString();
    const reposts = (lastPost.repostCount || 0).toLocaleString();
    const repostOfHTML =
      lastPost.kind === 'repost' && lastPost.originalAuthor
        ? `<div class="hover-card-post-meta"><span>↻ Reposted from @${escapeHTML(lastPost.originalAuthor)}</span></div>`
        : '';
    postHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label">
          <span>${activityLabel}</span>
          <span>${lastPostDateStr}</span>
        </div>
        <div class="hover-card-post">
          ${repostOfHTML}
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
          <span>${activityLabel}</span>
          <span>${lastPostDateStr}</span>
        </div>
        <div class="hover-card-post-meta">
          <span>${isHydrating ? 'Fetching post snippet...' : 'No text content (media only)'}</span>
          <a href="${profileUrl}" target="_blank" rel="noopener noreferrer">View feed ↗</a>
        </div>
      </div>
    `;
  } else {
    postHTML = `
      <div class="hover-card-section">
        <div class="hover-card-section-label"><span>Latest Activity</span><span>Never</span></div>
        <div class="hover-card-mutuals"><span>No posts, replies or reposts found</span></div>
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

function needsPreviewHydration(rawItem) {
  // Mutuals are unknown when the user skipped that part of the sync.
  if (rawItem.criteria && rawItem.criteria.mutualsCount === undefined) return true;
  return (
    rawItem.description === undefined &&
    (!rawItem.preview ||
      (!rawItem.preview.lastPost &&
        (!rawItem.preview.mutuals || rawItem.preview.mutuals.length === 0)))
  );
}

/** Lazily fetches bio, mutuals and latest post for an account, mutating it in place. */
async function hydratePreview(rawItem) {
  if (!atprotoApi || !state.agent || !state.user) return false;
  const enriched = await atprotoApi.fetchAccountPreview(state.agent, state.user.did, rawItem.did);
  rawItem.description = enriched.description;
  rawItem.preview = enriched.preview;
  if (enriched.mutualsCount !== undefined && rawItem.criteria) {
    rawItem.criteria.mutualsCount = enriched.mutualsCount;
    rawItem.criteria.hasMoreMutuals = enriched.hasMoreMutuals;
  }
  return true;
}

async function showHoverCard(item, anchorEl) {
  if (!hoverCard) return;
  activeHoverDid = item.did;

  const rawItem = state.followings.find((f) => f.did === item.did) || item;
  const needsHydration = needsPreviewHydration(rawItem);

  hoverCard.innerHTML = renderHoverCardHTML(rawItem, needsHydration);
  hoverCard.classList.remove('hidden');
  positionHoverCard(anchorEl);

  if (needsHydration) {
    try {
      const hydrated = await hydratePreview(rawItem);
      if (hydrated && activeHoverDid === rawItem.did && !hoverCard.classList.contains('hidden')) {
        hoverCard.innerHTML = renderHoverCardHTML(rawItem, false);
        positionHoverCard(anchorEl);
      }
    } catch (err) {
      console.warn('Could not lazily hydrate hover preview:', err);
    }
  }
}

/** Touch devices have no hover, so the same preview opens as a modal bottom sheet. */
async function showPreviewSheet(item) {
  const sheet = document.getElementById('preview-sheet');
  const content = document.getElementById('preview-sheet-content');
  if (!sheet || !content) return;

  const rawItem = state.followings.find((f) => f.did === item.did) || item;
  const needsHydration = needsPreviewHydration(rawItem);
  sheet.dataset.did = rawItem.did;
  content.innerHTML = renderHoverCardHTML(rawItem, needsHydration);
  if (!sheet.open) sheet.showModal();

  if (needsHydration) {
    try {
      const hydrated = await hydratePreview(rawItem);
      if (hydrated && sheet.open && sheet.dataset.did === rawItem.did) {
        content.innerHTML = renderHoverCardHTML(rawItem, false);
      }
    } catch (err) {
      console.warn('Could not lazily hydrate preview sheet:', err);
    }
  }
}
