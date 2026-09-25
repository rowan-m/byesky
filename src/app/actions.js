import {
  actionToast,
  batchUnfollowBtn,
  confirmModal,
  modalCancelBtn,
  modalConfirmBtn,
  modalDesc,
  modalTitle,
} from './dom.js';
import { atprotoApi, state } from './state.js';
import { getCurrentPageItems, renderDashboard, updateSelectedCounter } from './table.js';

function closeConfirmModal() {
  if (confirmModal?.open) confirmModal.close();
  state.pendingUnfollowDids = [];
}

export function setupActionListeners() {
  // Batch Unfollow Button (Direct if <= 10, Modal if > 10)
  batchUnfollowBtn.addEventListener('click', () => {
    const dids = Array.from(state.selectedDids);
    if (dids.length === 0) return;

    if (dids.length > 10) {
      state.pendingUnfollowDids = dids;
      const pageDids = new Set(getCurrentPageItems().map((item) => item.did));
      const offPageCount = dids.filter((did) => !pageDids.has(did)).length;
      const offPageNote =
        offPageCount > 0 ? ` (${offPageCount} on other page${offPageCount === 1 ? '' : 's'})` : '';
      modalTitle.textContent = 'Batch Unfollow Confirmation';
      modalDesc.textContent = `Are you sure you want to unfollow ${dids.length} selected accounts${offPageNote}?`;
      if (!confirmModal.open) confirmModal.showModal();
      modalCancelBtn.focus();
    } else {
      executeUnfollow(dids);
    }
  });

  // Native <dialog> close via Cancel, Confirm, Escape, or backdrop click
  modalCancelBtn.addEventListener('click', closeConfirmModal);

  modalConfirmBtn.addEventListener('click', () => {
    const dids = state.pendingUnfollowDids;
    closeConfirmModal();
    if (dids.length > 0) {
      executeUnfollow(dids);
    }
  });

  confirmModal.addEventListener('close', () => {
    state.pendingUnfollowDids = [];
  });

  confirmModal.addEventListener('click', (e) => {
    if (e.target === confirmModal) {
      closeConfirmModal();
    }
  });
}

export function hideActionToast() {
  if (!actionToast) return;
  actionToast.classList.add('hidden');
  actionToast.classList.remove('is-error');
  actionToast.replaceChildren();
}

export function showActionToast({ message, isError = false, actions = [] }) {
  if (!actionToast) return;
  actionToast.setAttribute('role', isError ? 'alert' : 'status');
  actionToast.classList.toggle('is-error', isError);

  const textSpan = document.createElement('span');
  textSpan.textContent = message;

  const actionsWrap = document.createElement('div');
  actionsWrap.className = 'action-toast-actions';

  for (const action of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn btn-sm ${action.primary ? 'btn-primary' : 'btn-secondary'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => action.onClick(btn));
    actionsWrap.appendChild(btn);
  }

  const dismissBtn = document.createElement('button');
  dismissBtn.type = 'button';
  dismissBtn.className = 'btn btn-secondary btn-sm';
  dismissBtn.setAttribute('aria-label', 'Dismiss notification');
  dismissBtn.textContent = '✕';
  dismissBtn.addEventListener('click', hideActionToast);
  actionsWrap.appendChild(dismissBtn);

  actionToast.replaceChildren(textSpan, actionsWrap);
  actionToast.classList.remove('hidden');
}

async function handleUndoUnfollow(dids, triggerBtn) {
  if (!dids || dids.length === 0) return;
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Re-following…';
  }
  let restored = 0;
  const failed = [];
  for (const did of dids) {
    try {
      const data = await atprotoApi.followUser(state.agent, state.user.did, did);
      const f = state.followings.find((item) => item.did === did);
      if (f) f.followingUri = data.followingUri;
      restored++;
    } catch (err) {
      failed.push({ did, error: err.message });
    }
  }
  renderDashboard(false);
  if (failed.length === 0) {
    showActionToast({
      message: `Re-followed ${restored} account${restored === 1 ? '' : 's'}.`,
    });
  } else {
    const retryDids = failed.map((f) => f.did);
    showActionToast({
      message: `Re-followed ${restored}, ${failed.length} failed.`,
      isError: true,
      actions: [
        {
          label: 'Retry failed',
          primary: true,
          onClick: (btn) => handleUndoUnfollow(retryDids, btn),
        },
      ],
    });
  }
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
    const data = await atprotoApi.batchUnfollow(state.agent, state.user.did, unlockedDids);

    const successes = data.success || [];
    const failures = data.failed || [];

    successes.forEach((did) => {
      const f = state.followings.find((item) => item.did === did);
      if (f) {
        f.followingUri = null;
      }
      state.selectedDids.delete(did);
    });

    renderDashboard(false);

    if (failures.length === 0 && successes.length > 0) {
      showActionToast({
        message: `Unfollowed ${successes.length} account${successes.length === 1 ? '' : 's'}.`,
        actions: [
          {
            label: 'Undo',
            onClick: (btn) => handleUndoUnfollow(successes, btn),
          },
        ],
      });
    } else if (failures.length > 0 && successes.length > 0) {
      const failedDids = failures.map((f) => f.did);
      showActionToast({
        message: `Unfollowed ${successes.length}, ${failures.length} failed.`,
        isError: true,
        actions: [
          {
            label: 'Retry failed',
            primary: true,
            onClick: () => executeUnfollow(failedDids),
          },
          {
            label: 'Undo',
            onClick: (btn) => handleUndoUnfollow(successes, btn),
          },
        ],
      });
    } else if (failures.length > 0) {
      const failedDids = failures.map((f) => f.did);
      const reason = failures[0]?.error ? ` (${failures[0].error})` : '';
      showActionToast({
        message: `Couldn't unfollow ${failures.length} account${failures.length === 1 ? '' : 's'}${reason}.`,
        isError: true,
        actions: [
          {
            label: 'Retry',
            primary: true,
            onClick: () => executeUnfollow(failedDids),
          },
        ],
      });
    }
  } catch (err) {
    showActionToast({
      message: `Couldn't unfollow: ${err.message || err}`,
      isError: true,
      actions: [
        {
          label: 'Retry',
          primary: true,
          onClick: () => executeUnfollow(unlockedDids),
        },
      ],
    });
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
    const data = await atprotoApi.followUser(state.agent, state.user.did, did);

    const f = state.followings.find((item) => item.did === did);
    if (f) {
      f.followingUri = data.followingUri;
    }

    renderDashboard(false);
    showActionToast({
      message: `Re-followed @${handle || did}.`,
    });
  } catch (err) {
    showActionToast({
      message: `Couldn't re-follow @${handle || did}: ${err.message || err}`,
      isError: true,
    });
    buttonEl.disabled = false;
    buttonEl.textContent = 'Re-follow';
  }
}
