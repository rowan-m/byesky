// DOM Elements. Module scripts run after the document is parsed, so these all resolve.
export const appLoadingSection = document.getElementById('app-loading-section');
export const authSection = document.getElementById('auth-section');
export const syncSection = document.getElementById('sync-section');
export const dashboardSection = document.getElementById('dashboard-section');
export const loginForm = document.getElementById('login-form');
export const loginHandle = document.getElementById('login-handle');
export const loginError = document.getElementById('login-error');
export const userProfile = document.getElementById('user-profile');
export const userHandleSpan = document.getElementById('user-handle');
export const logoutBtn = document.getElementById('logout-btn');

export const syncProgressBar = document.getElementById('sync-progress-bar');
export const syncStage = document.getElementById('sync-stage');
export const syncPercent = document.getElementById('sync-percent');
export const syncError = document.getElementById('sync-error');
export const syncStepTitle = document.getElementById('sync-step-title');
export const syncProgressTrack = document.getElementById('sync-progress-track');
export const syncEta = document.getElementById('sync-eta');
export const skipMutualsPanel = document.getElementById('skip-mutuals');
export const skipMutualsBtn = document.getElementById('skip-mutuals-btn');
export const syncElsewhere = document.getElementById('sync-elsewhere');
export const cancelSyncBtn = document.getElementById('cancel-sync-btn');
export const retrySyncBtn = document.getElementById('retry-sync-btn');

export const actionToast = document.getElementById('action-toast');
export const tableBody = document.getElementById('table-body');
export const tableSearch = document.getElementById('table-search');
export const selectAllCheckbox = document.getElementById('select-all');
export const batchUnfollowBtn = document.getElementById('batch-unfollow-btn');
export const selectedCountSpan = document.getElementById('selected-count');
export const emptyState = document.getElementById('empty-state');

export const paginationInfos = document.querySelectorAll('.pagination-info');
export const paginationPagesList = document.querySelectorAll('.pagination-pages');
export const prevPageBtns = document.querySelectorAll('.prev-page-btn');
export const nextPageBtns = document.querySelectorAll('.next-page-btn');

export const resyncBtn = document.getElementById('resync-btn');
export const lastSyncedTime = document.getElementById('last-synced-time');

// Unfollow Confirmation Modal Elements
export const confirmModal = document.getElementById('confirm-modal');
export const modalTitle = document.getElementById('modal-title');
export const modalDesc = document.getElementById('modal-desc');
export const modalCancelBtn = document.getElementById('modal-cancel-btn');
export const modalConfirmBtn = document.getElementById('modal-confirm-btn');

// Singleton Rich Hover Preview Card
export const hoverCard = document.getElementById('profile-hover-card');
