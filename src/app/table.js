import { syncCache } from '../cache.js';
import { negativeBadges, SCAN_LIMIT_LABEL } from '../criteria.js';
import {
  escapeHTML,
  filterAndSortFollowings,
  sanitizeUrl,
  truncateText,
  UNKNOWN_SOURCE_LABELS,
} from '../scoring.js';
import { executeUnfollow, handleRefollow } from './actions.js';
import {
  batchUnfollowBtn,
  emptyState,
  nextPageBtns,
  paginationInfos,
  paginationPagesList,
  prevPageBtns,
  selectAllCheckbox,
  selectedCountSpan,
  tableBody,
  tableSearch,
} from './dom.js';
import { formatCount, formatMutualsCount, formatRelativeDate } from './format.js';
import { state } from './state.js';

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

  // Select All checkbox
  selectAllCheckbox.addEventListener('change', handleSelectAllToggle);

  // Delegated row controls on tableBody (single listener instead of 400+ per render)
  tableBody.addEventListener('click', async (e) => {
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
  });

  tableBody.addEventListener('change', (e) => {
    const checkbox = e.target.closest('.row-checkbox');
    if (!checkbox) return;
    const did = checkbox.dataset.did;
    if (!did || state.lockedDids.has(did)) return;
    if (checkbox.checked) {
      state.selectedDids.add(did);
    } else {
      state.selectedDids.delete(did);
    }
    checkbox.closest('tr')?.classList.toggle('selected-row', checkbox.checked);
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

function badge(kind, title, label) {
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
    out.push(badge('success', 'Nothing with a weight above 0 matches this account', 'OK'));
  } else {
    for (const b of negativeBadges(item, state.params)) {
      out.push(badge(b.kind, b.title, b.label));
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
      const lastInteractionMs =
        item._lastInteractionMs ?? (lastInteractionDate ? Date.parse(lastInteractionDate) || 0 : 0);
      if (lastInteractionMs > 0) {
        const daysSinceInteraction = (Date.now() - lastInteractionMs) / (1000 * 60 * 60 * 24);
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
          cellContentHTML = `<a href="${safeLinkUrl}" target="_blank" rel="noopener noreferrer" class="interaction-link" title="View last ${safeType} on Bluesky">${relativeDateStr}${typeLabel}</a>`;
        } else {
          cellContentHTML = `${relativeDateStr}${typeLabel}`;
        }
      }

      const displayNameHTML = truncateText(item.displayName || item.handle.split('.')[0], 16);
      const handleHTML = truncateText('@' + item.handle, 20);

      let checkboxHTML;
      if (isUnfollowed) {
        checkboxHTML = '<span class="text-muted text-center unfollowed-dash">—</span>';
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
        <td class="col-meta col-followers ${isLowFollowers ? 'criteria-highlight' : ''}" data-label="Followers">${escapeHTML(formatCount(item.criteria.followersCount))}</td>
        <td class="col-meta col-last-post ${isPostInactive ? 'criteria-highlight' : ''}" data-label="Last post">${escapeHTML(formatRelativeDate(item.criteria.lastPostDate))}</td>
        <td class="col-meta col-last-interaction ${isInteractionInactive ? 'criteria-highlight' : ''}" data-label="Last interaction">${cellContentHTML}</td>
        <td class="col-flags">
          <div class="flags-list">${isUnfollowed ? '<span class="badge badge-secondary">Unfollowed</span>' : badgesHTML}</div>
        </td>
        <td class="col-score score-cell ${scoreClass}">${escapeHTML(item.score)}</td>
        <td class="col-action text-right">
          ${actionButtonHTML}
        </td>
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
