import {
  batchUnfollowBtn,
  confirmModal,
  modalCancelBtn,
  modalConfirmBtn,
  modalDesc,
  modalTitle,
} from './dom.js';
import { atprotoApi, state } from './state.js';
import { onSyncUpdate } from './sync-ui.js';
import { renderDashboard, updateSelectedCounter } from './table.js';

export function setupActionListeners() {
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
}

export async function executeUnfollow(dids, buttonEl) {
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

export async function handleRefollow(did, handle, buttonEl) {
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
