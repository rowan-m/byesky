import { syncCache } from '../cache.js';
import { negativeBadges, SCAN_LIMIT_LABEL } from '../criteria.js';
import {
  escapeHTML,
  filterAndSortFollowings,
  isAccountIncomplete,
  sanitizeUrl,
  truncateText,
  UNKNOWN_SOURCE_LABELS,
} from '../scoring.js';
import { executeUnfollow, handleRefollow, triggerUndoAction } from './actions.js';
import { getSoloFilterKey, toggleSoloFilter } from './config-panel.js';
import {
  batchUnfollowBtn,
  confirmModal,
  dashboardSection,
  emptyState,
  incompleteCountSpan,
  nextPageBtns,
  paginationInfos,
  paginationPagesList,
  prevPageBtns,
  retryIncompleteBtn,
  selectAllCheckbox,
  selectedCountSpan,
  shortcutsLegend,
  shortcutsToggleBtn,
  tableBody,
  tableSearch,
} from './dom.js';
import { formatCount, formatMutualsCount, formatRelativeDate } from './format.js';
import { syncOpenPreview, togglePreviewForItem } from './preview.js';
import { getFollowing, state } from './state.js';

const FOCUSABLE_ROW_SELECTORS = [
  '.row-checkbox',
  '.lock-toggle-btn',
  '.preview-btn',
  '.unfollow-single-btn',
  '.refollow-single-btn',
  '.profile-link',
];

let tableCacheRev = 0;
let cachedListKey = null;
let cachedListFollowings = null;
let cachedListResult = null;

export function invalidateTableCache() {
  tableCacheRev++;
  cachedListKey = null;
}

function computeTableCacheKey() {
  return JSON.stringify({
    rev: tableCacheRev,
    len: state.followings.length,
    q: state.searchQuery,
    col: state.sorting.col,
    order: state.sorting.order,
    weights: state.weights,
    filters: state.filters,
    params: state.params,
    locked: Array.from(state.lockedDids),
  });
}

function scrollToTop() {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

function findRowElement(did) {
  if (!did || !tableBody) return null;
  for (const tr of tableBody.querySelectorAll('tr[data-did]')) {
    if (tr.dataset.did === did) return tr;
  }
  return null;
}

export function setActiveRow(did, { scroll = false, syncPreview = false } = {}) {
  state.activeDid = did || null;
  const pageItems = getCurrentPageItems();
  const idx = pageItems.findIndex((item) => item.did === state.activeDid);
  if (idx !== -1) {
    state.activeRowIndex = idx;
  }

  let activeTr = null;
  for (const tr of tableBody.querySelectorAll('tr[data-did]')) {
    const isMatch = tr.dataset.did === state.activeDid;
    tr.classList.toggle('active-row', isMatch);
    if (isMatch) activeTr = tr;
  }

  if (scroll && activeTr) {
    activeTr.scrollIntoView({ block: 'nearest' });
  }
  if (syncPreview) {
    syncOpenPreview(state.activeDid ? getFollowing(state.activeDid) : null);
  }
}

function resolveOrInitActiveItem() {
  const pageItems = getCurrentPageItems();
  if (pageItems.length === 0) return null;
  const existing = pageItems.find((item) => item.did === state.activeDid);
  if (existing) return existing;
  setActiveRow(pageItems[0].did, { scroll: true });
  return pageItems[0];
}

async function toggleLockForDid(did) {
  if (!did) return;
  if (state.lockedDids.has(did)) {
    state.lockedDids.delete(did);
  } else {
    state.lockedDids.add(did);
    state.selectedDids.delete(did);
  }
  if (state.user) {
    await syncCache.setLockedDids(state.user.did, Array.from(state.lockedDids));
  }
  renderDashboard(false);
}

function applyRowSelection(did, selected) {
  if (!did || state.lockedDids.has(did)) return;
  const item = getFollowing(did);
  if (!item || !item.followingUri) return;
  if (selected) {
    state.selectedDids.add(did);
  } else {
    state.selectedDids.delete(did);
  }
  const tr = findRowElement(did);
  if (tr) {
    tr.classList.toggle('selected-row', selected);
    const cb = tr.querySelector('.row-checkbox');
    if (cb) cb.checked = selected;
  }
}

function applyRangeSelection(fromDid, toDid, targetSelected) {
  const pageItems = getCurrentPageItems();
  const fromIdx = pageItems.findIndex((item) => item.did === fromDid);
  const toIdx = pageItems.findIndex((item) => item.did === toDid);
  if (fromIdx === -1 || toIdx === -1) {
    applyRowSelection(toDid, targetSelected);
    return;
  }
  const start = Math.min(fromIdx, toIdx);
  const end = Math.max(fromIdx, toIdx);
  for (let i = start; i <= end; i++) {
    applyRowSelection(pageItems[i].did, targetSelected);
  }
}

function toggleShortcutsLegend() {
  if (!shortcutsLegend || !shortcutsToggleBtn) return;
  const isHidden = shortcutsLegend.classList.toggle('hidden');
  shortcutsToggleBtn.setAttribute('aria-expanded', String(!isHidden));
}

function isKeyboardShortcutBlocked(e) {
  if (!dashboardSection || dashboardSection.classList.contains('hidden')) return true;
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  if (confirmModal?.open) return true;
  if (document.documentElement.classList.contains('is-config-overlay')) return true;
  const target = e.target;
  if (!target || typeof target.matches !== 'function') return false;
  return target.matches('input:not([type="checkbox"]), textarea, select, [contenteditable="true"]');
}

async function handleTableKeydown(e) {
  if (isKeyboardShortcutBlocked(e)) return;

  const key = e.key;
  if (key === '?') {
    e.preventDefault();
    toggleShortcutsLegend();
    return;
  }

  if (key === 'z' || key === 'Z') {
    if (triggerUndoAction()) {
      e.preventDefault();
    }
    return;
  }

  if (key === '[') {
    if (state.pagination.currentPage > 1) {
      e.preventDefault();
      state.pagination.currentPage--;
      state.activeDid = null;
      state.activeRowIndex = 0;
      renderDashboard(false);
      scrollToTop();
    }
    return;
  }

  if (key === ']') {
    const totalPages = Math.ceil(getFilteredAndSortedList().length / state.pagination.pageSize);
    if (state.pagination.currentPage < totalPages) {
      e.preventDefault();
      state.pagination.currentPage++;
      state.activeDid = null;
      state.activeRowIndex = 0;
      renderDashboard(false);
      scrollToTop();
    }
    return;
  }

  const isDown = key === 'ArrowDown' || key === 'j' || key === 'J' || key === 's' || key === 'S';
  const isUp = key === 'ArrowUp' || key === 'k' || key === 'K' || key === 'w' || key === 'W';

  if (isDown || isUp) {
    const pageItems = getCurrentPageItems();
    if (pageItems.length === 0) return;
    e.preventDefault();

    const curIdx = pageItems.findIndex((item) => item.did === state.activeDid);
    let nextIdx;
    if (curIdx === -1) {
      nextIdx = 0;
    } else if (isDown) {
      nextIdx = Math.min(pageItems.length - 1, curIdx + 1);
    } else {
      nextIdx = Math.max(0, curIdx - 1);
    }

    if (e.shiftKey) {
      const startDid = pageItems[curIdx >= 0 ? curIdx : 0].did;
      const nextDid = pageItems[nextIdx].did;
      applyRangeSelection(startDid, nextDid, true);
      state.lastSelectedDid = nextDid;
      updateSelectedCounter();
      renderCheckboxHeaders(pageItems);
    }

    // If focus was inside another row's control, blur it so Space acts on the new active row.
    if (
      document.activeElement &&
      tableBody.contains(document.activeElement) &&
      document.activeElement.closest('tr[data-did]')?.dataset.did !== pageItems[nextIdx].did
    ) {
      document.activeElement.blur();
    }

    setActiveRow(pageItems[nextIdx].did, { scroll: true, syncPreview: true });
    return;
  }

  if (key === ' ') {
    // Allow native Space activation on interactive controls outside the table body,
    // except when the preview sheet is open (where focus is inside #preview-sheet).
    if (
      e.target &&
      typeof e.target.matches === 'function' &&
      e.target.matches('button, a[href], summary, input[type="checkbox"]') &&
      !tableBody.contains(e.target) &&
      !e.target.closest('#preview-sheet')
    ) {
      return;
    }
    const activeItem = resolveOrInitActiveItem();
    if (!activeItem) return;
    e.preventDefault();
    if (!activeItem.followingUri || state.lockedDids.has(activeItem.did)) return;
    const nextSelected = !state.selectedDids.has(activeItem.did);
    applyRowSelection(activeItem.did, nextSelected);
    state.lastSelectedDid = activeItem.did;
    updateSelectedCounter();
    renderCheckboxHeaders(getCurrentPageItems());
    return;
  }

  if (key === 'l' || key === 'L') {
    const activeItem = resolveOrInitActiveItem();
    if (!activeItem || !activeItem.followingUri) return;
    e.preventDefault();
    await toggleLockForDid(activeItem.did);
    syncOpenPreview(state.activeDid ? getFollowing(state.activeDid) : null);
    return;
  }

  if (key === 'u' || key === 'U') {
    const activeItem = resolveOrInitActiveItem();
    if (!activeItem) return;
    e.preventDefault();
    const rowEl = findRowElement(activeItem.did);
    if (!activeItem.followingUri) {
      const refollowBtn = rowEl?.querySelector('.refollow-single-btn');
      if (refollowBtn?.disabled) return;
      await handleRefollow(activeItem.did, activeItem.handle, refollowBtn);
    } else if (!state.lockedDids.has(activeItem.did)) {
      const unfollowBtn = rowEl?.querySelector('.unfollow-single-btn');
      if (unfollowBtn?.disabled) return;
      await executeUnfollow([activeItem.did], unfollowBtn);
    }
    syncOpenPreview(state.activeDid ? getFollowing(state.activeDid) : null);
    return;
  }

  if (key === 'i' || key === 'I') {
    const activeItem = resolveOrInitActiveItem();
    if (!activeItem) return;
    e.preventDefault();
    togglePreviewForItem(activeItem);
    return;
  }

  if (key === 'o' || key === 'O') {
    const activeItem = resolveOrInitActiveItem();
    if (!activeItem) return;
    e.preventDefault();
    window.open(
      `https://bsky.app/profile/${encodeURIComponent(activeItem.handle)}`,
      '_blank',
      'noopener,noreferrer',
    );
  }
}

export function setupTableListeners() {
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

  // Shortcuts legend toggle button
  shortcutsToggleBtn?.addEventListener('click', toggleShortcutsLegend);

  // Global keyboard navigation & triage shortcuts
  document.addEventListener('keydown', handleTableKeydown);

  // Select All checkbox
  selectAllCheckbox.addEventListener('change', handleSelectAllToggle);

  // Delegated row controls on tableBody (single listener instead of 400+ per render)
  tableBody.addEventListener('click', async (e) => {
    const rowEl = e.target.closest('tr[data-did]');
    if (rowEl?.dataset.did) {
      setActiveRow(rowEl.dataset.did);
    }

    const checkbox = e.target.closest('.row-checkbox');
    if (checkbox) {
      const did = checkbox.dataset.did;
      if (!did || state.lockedDids.has(did)) return;
      if (e.shiftKey && state.lastSelectedDid && state.lastSelectedDid !== did) {
        applyRangeSelection(state.lastSelectedDid, did, checkbox.checked);
        updateSelectedCounter();
        renderCheckboxHeaders(getCurrentPageItems());
      }
      state.lastSelectedDid = did;
      return;
    }

    const refollowBtn = e.target.closest('.refollow-single-btn');
    if (refollowBtn) {
      await handleRefollow(refollowBtn.dataset.did, refollowBtn.dataset.handle, refollowBtn);
      return;
    }

    const unfollowBtn = e.target.closest('.unfollow-single-btn');
    if (unfollowBtn) {
      const did = unfollowBtn.dataset.did;
      if (!did || state.lockedDids.has(did)) return;
      await executeUnfollow([did], unfollowBtn);
      return;
    }

    const lockBtn = e.target.closest('.lock-toggle-btn');
    if (lockBtn) {
      const did = lockBtn.dataset.did;
      if (!did) return;
      await toggleLockForDid(did);
      return;
    }

    const filterBadge = e.target.closest('.badge-filter');
    if (filterBadge?.dataset.filterKey) {
      toggleSoloFilter(filterBadge.dataset.filterKey);
    }
  });

  tableBody.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.row-checkbox');
    if (!checkbox) return;
    const did = checkbox.dataset.did;
    if (!did || state.lockedDids.has(did)) return;
    applyRowSelection(did, checkbox.checked);
    state.lastSelectedDid = did;
    updateSelectedCounter();
    renderCheckboxHeaders(getCurrentPageItems());
  });

  // Table header sorting (clicking the <button class="sort-btn"> bubbles to <th class="sortable">)
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
        state.activeDid = null;
        state.activeRowIndex = 0;
        renderDashboard(false);
        scrollToTop();
      }
    });
  });

  nextPageBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const totalPages = Math.ceil(getFilteredAndSortedList().length / state.pagination.pageSize);
      if (state.pagination.currentPage < totalPages) {
        state.pagination.currentPage++;
        state.activeDid = null;
        state.activeRowIndex = 0;
        renderDashboard(false);
        scrollToTop();
      }
    });
  });
}

export function getFilteredAndSortedList() {
  const key = computeTableCacheKey();
  if (cachedListResult && cachedListFollowings === state.followings && cachedListKey === key) {
    return cachedListResult;
  }
  cachedListFollowings = state.followings;
  cachedListKey = key;
  cachedListResult = filterAndSortFollowings(state.followings, state);
  return cachedListResult;
}

export function getCurrentPageItems(list = getFilteredAndSortedList()) {
  const startIdx = (state.pagination.currentPage - 1) * state.pagination.pageSize;
  const endIdx = Math.min(startIdx + state.pagination.pageSize, list.length);
  return list.slice(startIdx, endIdx);
}

function badge(kind, title, label, filterKey = null) {
  if (filterKey) {
    const isSolo = getSoloFilterKey() === filterKey;
    const hint = isSolo
      ? `${title} — Click to restore all filters`
      : `${title} — Click to show only ${label} accounts`;
    return `<button type="button" class="badge badge-${kind} badge-filter ${isSolo ? 'is-solo-filter' : ''}" data-filter-key="${escapeHTML(filterKey)}" aria-pressed="${isSolo}" title="${escapeHTML(hint)}">${escapeHTML(label)}</button>`;
  }
  return `<span class="badge badge-${kind}" title="${escapeHTML(title)}">${escapeHTML(label)}</span>`;
}

/**
 * Criteria badges for a row, driven by the same evaluation as the score and filters so the
 * OK badge and the OK filter always agree.
 */
function renderCriteriaBadges(item) {
  const c = item.criteria;
  const out = [];

  if (item.isOk) {
    out.push(badge('success', 'Nothing with a weight above 0 matches this account', 'OK', 'ok'));
  } else {
    for (const b of negativeBadges(item, state.params)) {
      out.push(badge(b.kind, b.title, b.label, b.filterKey));
    }
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
    const inProgress = state.sync?.status === 'fetching' || state.sync?.status === 'enriching';
    const tooltip = inProgress
      ? `Fetching ${what} for this account is in progress. Criteria that depend on it will update once fetched.`
      : `Couldn't fetch ${what} for this account, so criteria that depend on it are skipped. Click Retry Incomplete in the header to try again.`;
    out.push(badge('info', tooltip, 'INCOMPLETE'));
  }

  return out.join('');
}

function captureFocusedRowControl() {
  const active = document.activeElement;
  if (!active || !tableBody.contains(active)) return null;
  const rowEl = active.closest('tr[data-did]');
  const did = active.dataset?.did || rowEl?.dataset?.did;
  const selector = FOCUSABLE_ROW_SELECTORS.find((s) => active.matches(s));
  return did && selector ? { did, selector } : null;
}

function restoreFocusedRowControl(focused) {
  if (!focused) return;
  const rows = tableBody.querySelectorAll('tr[data-did]');
  let targetRow = null;
  for (const tr of rows) {
    if (tr.dataset.did === focused.did) {
      targetRow = tr;
      break;
    }
  }
  if (!targetRow) return;
  const el =
    targetRow.querySelector(focused.selector) ||
    targetRow.querySelector('.unfollow-single-btn, .refollow-single-btn');
  if (el && !el.disabled) {
    el.focus({ preventScroll: true });
  }
}

export function renderDashboard(resetSelection = false) {
  if (resetSelection) {
    state.selectedDids.clear();
    selectAllCheckbox.checked = false;
  }

  const list = getFilteredAndSortedList();
  const totalCount = list.length;

  // Keep selections across weight/param/sort edits, but drop any accounts that are no
  // longer visible or selectable (e.g. hidden by a filter or search, locked, or unfollowed).
  if (state.selectedDids.size > 0) {
    const visibleSelectable = new Set();
    for (const item of list) {
      if (item.followingUri && !state.lockedDids.has(item.did)) {
        visibleSelectable.add(item.did);
      }
    }
    for (const did of state.selectedDids) {
      if (!visibleSelectable.has(did)) state.selectedDids.delete(did);
    }
  }

  // Handle pagination clamp
  const totalPages = Math.ceil(totalCount / state.pagination.pageSize) || 1;
  if (state.pagination.currentPage > totalPages) {
    state.pagination.currentPage = totalPages;
  }

  const startIdx = (state.pagination.currentPage - 1) * state.pagination.pageSize;
  const endIdx = Math.min(startIdx + state.pagination.pageSize, totalCount);
  const pageItems = list.slice(startIdx, endIdx);

  // Reconcile active row cursor: if the active row was removed from the current view
  // (e.g. unfollowed while the Unfollowed filter is off), keep the cursor at the same row index.
  if (pageItems.length === 0) {
    state.activeDid = null;
    state.activeRowIndex = 0;
  } else if (state.activeDid !== null) {
    const existingIdx = pageItems.findIndex((item) => item.did === state.activeDid);
    if (existingIdx !== -1) {
      state.activeRowIndex = existingIdx;
    } else {
      const clampedIdx = Math.min(Math.max(0, state.activeRowIndex), pageItems.length - 1);
      state.activeRowIndex = clampedIdx;
      state.activeDid = pageItems[clampedIdx].did;
    }
  }

  const focusedTarget = captureFocusedRowControl();

  // Render Table rows
  tableBody.innerHTML = '';

  if (pageItems.length === 0) {
    emptyState.classList.remove('hidden');
  } else {
    emptyState.classList.add('hidden');
    pageItems.forEach((item) => {
      const row = document.createElement('tr');
      row.dataset.did = item.did;

      let badgesHTML = renderCriteriaBadges(item);

      const isLocked = state.lockedDids.has(item.did);
      if (isLocked) {
        badgesHTML =
          badge(
            'locked',
            'Protected: This account is locked and excluded from Select All and unfollowing',
            '🔒 LOCKED',
            'locked',
          ) + badgesHTML;
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
      if (item.did === state.activeDid) {
        row.classList.add('active-row');
      }

      const isProfilePending = item.criteria.unknown?.includes('profile');
      const isActivityPending = item.criteria.unknown?.includes('activity');
      const isInteractionPending =
        state.sync?.status === 'fetching' ||
        (state.sync?.status === 'enriching' &&
          ['notifications', 'ownPosts', 'likes'].includes(state.sync?.progress?.step?.id));

      const isLowFollowers = !isProfilePending && item.evaluation.matches.lowFollowers === true;
      const isPostInactive = !isActivityPending && (item.neverPosted || item.dynamicInactive);

      let isInteractionInactive = true;
      const lastInteractionDate = item.criteria.lastInteraction?.date || item.criteria.lastLikeDate;
      const lastInteractionMs =
        item._lastInteractionMs ?? (lastInteractionDate ? Date.parse(lastInteractionDate) || 0 : 0);
      if (lastInteractionMs > 0) {
        const daysSinceInteraction = (Date.now() - lastInteractionMs) / (1000 * 60 * 60 * 24);
        isInteractionInactive = daysSinceInteraction > state.params.inactiveDays;
      }
      const isInteractionHighlight = !isInteractionPending && isInteractionInactive;

      // Generate Last Interaction content with type label and bsky.app hyperlink
      const interactionInfo = item.criteria.lastInteraction;
      const renderDate = interactionInfo?.date || item.criteria.lastLikeDate;

      let cellContentHTML;
      if (isInteractionPending) {
        cellContentHTML = '<span title="Pending">~</span>';
      } else if (renderDate) {
        const relativeDateStr = escapeHTML(formatRelativeDate(renderDate));
        let typeLabel = '';
        const safeType = escapeHTML(interactionInfo?.type || '');
        if (interactionInfo?.type) {
          const typeMap = {
            like: 'Like',
            reply: 'Reply',
            repost: 'Repost',
            message: 'DM',
            quote: 'Quote',
            mention: 'Mention',
          };
          typeLabel = ` (${escapeHTML(typeMap[interactionInfo.type] || interactionInfo.type)})`;
        }

        const safeLinkUrl = sanitizeUrl(interactionInfo?.link, '');
        if (safeLinkUrl) {
          cellContentHTML = `<a href="${safeLinkUrl}" target="_blank" rel="noopener noreferrer" class="interaction-link" title="View last ${safeType} on Bluesky">${relativeDateStr}${typeLabel}</a>`;
        } else {
          cellContentHTML = `${relativeDateStr}${typeLabel}`;
        }
      } else {
        cellContentHTML = `<span class="empty-interaction" title="No interaction found in your last ${SCAN_LIMIT_LABEL} notifications, posts, and likes">None in last ${SCAN_LIMIT_LABEL}</span>`;
      }

      const displayNameHTML = truncateText(item.displayName || item.handle.split('.')[0], 16);
      const handleHTML = truncateText('@' + item.handle, 20);

      const followersHTML = isProfilePending
        ? '<span title="Pending">~</span>'
        : escapeHTML(formatCount(item.criteria.followersCount));

      const lastPostHTML = isActivityPending
        ? '<span title="Pending">~</span>'
        : escapeHTML(formatRelativeDate(item.criteria.lastPostDate));

      let controlsHTML;
      if (isUnfollowed) {
        controlsHTML = `
          <div class="cell-controls is-unfollowed">
            <button type="button" class="btn btn-primary btn-sm refollow-single-btn" data-did="${safeDid}" data-handle="${safeHandle}" title="Re-follow account (U)" aria-label="Re-follow ${safeLabelName}">↩️ Re-follow</button>
          </div>
        `;
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
        const unfollowTitle = isLocked ? 'Unlock account to unfollow' : 'Unfollow account (U)';
        const unfollowDisabledAttr = isLocked ? 'disabled' : '';

        controlsHTML = `
          <div class="cell-controls">
            <input type="checkbox" class="row-checkbox" data-did="${safeDid}" ${checkedAttr} ${disabledAttr} aria-label="${checkboxLabel}">
            <button type="button" class="lock-toggle-btn ${isLocked ? 'is-locked' : ''}" data-did="${safeDid}" title="${lockTitle}" aria-label="${lockActionLabel}" aria-pressed="${isLocked}">${isLocked ? '🔒' : '🔓'}</button>
            <button type="button" class="unfollow-single-btn" data-did="${safeDid}" data-handle="${safeHandle}" ${unfollowDisabledAttr} title="${unfollowTitle}" aria-label="Unfollow ${safeLabelName}">👋</button>
          </div>
        `;
      }

      row.innerHTML = `
        <td class="col-checkbox">
          ${controlsHTML}
        </td>
        <td class="col-profile">
          <div class="profile-cell">
            <a href="https://bsky.app/profile/${encodeURIComponent(item.handle)}" target="_blank" rel="noopener noreferrer" class="profile-link">
              <img class="avatar" src="${avatarSrc}" alt="" width="26" height="26" loading="lazy">
              <div class="profile-info">
                <span class="display-name">${displayNameHTML}</span>
                <span class="handle">${handleHTML}</span>
              </div>
            </a>
            <button type="button" class="preview-btn" aria-label="Preview @${safeHandle}" aria-haspopup="dialog">ⓘ</button>
          </div>
        </td>
        <td class="col-meta col-followers ${isLowFollowers ? 'criteria-highlight' : ''}" data-label="Followers">${followersHTML}</td>
        <td class="col-meta col-last-post ${isPostInactive ? 'criteria-highlight' : ''}" data-label="Last post">${lastPostHTML}</td>
        <td class="col-meta col-last-interaction ${isInteractionHighlight ? 'criteria-highlight' : ''}" data-label="Last interaction">${cellContentHTML}</td>
        <td class="col-flags">
          <div class="flags-list">${isUnfollowed ? badge('secondary', 'Unfollowed account', 'Unfollowed', 'unfollowed') : badgesHTML}</div>
        </td>
        <td class="col-score score-cell ${scoreClass}">${escapeHTML(item.score)}</td>
      `;

      tableBody.appendChild(row);
    });
  }

  restoreFocusedRowControl(focusedTarget);

  // Render sorting indicators and aria-sort on headers
  document.querySelectorAll('.sortable').forEach((th) => {
    th.classList.remove('sort-asc', 'sort-desc');
    const sortCol = th.dataset.sort;
    if (state.sorting.col === sortCol) {
      const isAsc = state.sorting.order === 'asc';
      th.classList.add(isAsc ? 'sort-asc' : 'sort-desc');
      th.setAttribute('aria-sort', isAsc ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
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
      pageBtn.type = 'button';
      pageBtn.className = `page-link ${state.pagination.currentPage === i ? 'active' : ''}`;
      pageBtn.textContent = i;
      if (state.pagination.currentPage === i) {
        pageBtn.setAttribute('aria-current', 'page');
      }
      pageBtn.addEventListener('click', () => {
        state.pagination.currentPage = i;
        state.activeDid = null;
        state.activeRowIndex = 0;
        renderDashboard(false);
        scrollToTop();
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
  updateIncompleteCounter();
}

export function countIncompleteFollowings(followings = state.followings) {
  const includeSkippedMutuals = Boolean(state.sync?.mutualsSkipped);
  let count = 0;
  for (const item of followings) {
    if (isAccountIncomplete(item, { includeSkippedMutuals })) count++;
  }
  return count;
}

export function updateIncompleteCounter() {
  if (!retryIncompleteBtn || !incompleteCountSpan) return;
  const count = countIncompleteFollowings();
  incompleteCountSpan.textContent = String(count);
  const inProgress = state.sync?.status === 'fetching' || state.sync?.status === 'enriching';
  retryIncompleteBtn.classList.toggle('hidden', count === 0);
  retryIncompleteBtn.disabled = inProgress || count === 0;
}

export function renderCheckboxHeaders(pageItems) {
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
  const selectableItems = getCurrentPageItems().filter(
    (item) => Boolean(item.followingUri) && !state.lockedDids.has(item.did),
  );

  if (e.target.checked) {
    selectableItems.forEach((item) => state.selectedDids.add(item.did));
  } else {
    selectableItems.forEach((item) => state.selectedDids.delete(item.did));
  }
  renderDashboard(false);
}

export function updateSelectedCounter() {
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
