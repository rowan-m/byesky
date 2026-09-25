import { syncCache } from '../cache.js';
import {
  authSection,
  cancelSyncBtn,
  dashboardSection,
  lastSyncedTime,
  resyncBtn,
  retrySyncBtn,
  selectAllCheckbox,
  skipMutualsBtn,
  skipMutualsPanel,
  syncElsewhere,
  syncError,
  syncEta,
  syncPercent,
  syncProgressBar,
  syncProgressTrack,
  syncSection,
  syncStage,
  syncStepTitle,
} from './dom.js';
import { formatLastSynced } from './format.js';
import { hideLoading } from './session.js';
import { atprotoApi, setFollowings, state } from './state.js';
import { renderDashboard } from './table.js';

// Tracks progress within the current step to estimate the time remaining.
let etaSample = null;
let syncUpdateFrame = null;

export function setupSyncListeners() {
  resyncBtn.addEventListener('click', triggerSync);
  cancelSyncBtn.addEventListener('click', handleCancelSync);
  retrySyncBtn.addEventListener('click', handleRetrySync);
  skipMutualsBtn?.addEventListener('click', handleSkipMutuals);
}

export async function checkSyncStatus() {
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

export async function triggerSync() {
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
export function onSyncUpdate() {
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

export async function loadFollowings() {
  if (!state.user) return;

  try {
    const cachedState = await syncCache.get(state.user.did);
    setFollowings(cachedState.followings || []);
    state.lockedDids = new Set(await syncCache.getLockedDids(state.user.did));

    // Hide progress, loader, and auth connection card, show dashboard
    hideLoading();
    authSection.classList.add('hidden');
    syncSection.classList.add('hidden');
    dashboardSection.classList.remove('hidden');
    renderDashboard(true);
  } catch (err) {
    console.error('Load followings error:', err);
  }
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

// "Last synced" is when a sync last finished. Entries from before completedAt existed fall
// back to their last write, which is only meaningful once the sync completed.
function renderLastSynced(entry) {
  const at = entry.completedAt ?? (entry.status === 'completed' ? entry.lastUpdated : null);
  lastSyncedTime.textContent = at ? formatLastSynced(at) : '';
}
