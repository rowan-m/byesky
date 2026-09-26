import { escapeHTML, sanitizeUrl } from '../scoring.js';
import { hoverCard, tableBody } from './dom.js';
import { formatCount, formatMutualsCount, formatRelativeDate } from './format.js';
import { atprotoApi, getFollowing, state } from './state.js';
import { invalidateTableCache } from './table.js';

let hoverShowTimeout = null;
let hoverHideTimeout = null;
let activeHoverDid = null;
const inflightPreviews = new Map();

export function setupPreviewListeners() {
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

  // Delegated row preview button & profile-cell hover listeners on the table body
  if (tableBody) {
    tableBody.addEventListener('click', (e) => {
      const btn = e.target.closest('.preview-btn');
      if (!btn) return;
      const row = btn.closest('tr[data-did]');
      const item = row ? getFollowing(row.dataset.did) : null;
      if (!item) return;
      hideHoverCardImmediately();
      showPreviewSheet(item);
    });

    if (hoverCard) {
      tableBody.addEventListener('mouseover', (e) => {
        const profileCell = e.target.closest('.profile-cell');
        if (!profileCell || profileCell.contains(e.relatedTarget)) return;
        const row = profileCell.closest('tr[data-did]');
        const item = row ? getFollowing(row.dataset.did) : null;
        if (!item) return;
        clearTimeout(hoverHideTimeout);
        clearTimeout(hoverShowTimeout);
        hoverShowTimeout = setTimeout(() => {
          showHoverCard(item, profileCell);
        }, 180);
      });

      tableBody.addEventListener('mouseout', (e) => {
        const profileCell = e.target.closest('.profile-cell');
        if (!profileCell || profileCell.contains(e.relatedTarget)) return;
        clearTimeout(hoverShowTimeout);
        scheduleHideHoverCard();
      });
    }
  }

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

  const followersStr = formatCount(item.criteria?.followersCount ?? 0);
  const followsStr = formatCount(item.criteria?.followsCount ?? 0);
  const postsStr = formatCount(item.criteria?.postsCount ?? 0);

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
      <img class="hover-card-avatar" src="${avatarSrc}" alt="" width="38" height="38">
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
  if (rawItem._previewHydrated) return false;
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
  const existing = inflightPreviews.get(rawItem.did);
  if (existing) return existing;

  const task = (async () => {
    try {
      const enriched = await atprotoApi.fetchAccountPreview(
        state.agent,
        state.user.did,
        rawItem.did,
      );
      rawItem.description = enriched.description ?? '';
      rawItem.preview = enriched.preview;
      rawItem._previewHydrated = true;
      if (enriched.mutualsCount !== undefined && rawItem.criteria) {
        rawItem.criteria.mutualsCount = enriched.mutualsCount;
        rawItem.criteria.hasMoreMutuals = enriched.hasMoreMutuals;
        invalidateTableCache();
      }
      return true;
    } finally {
      inflightPreviews.delete(rawItem.did);
    }
  })();

  inflightPreviews.set(rawItem.did, task);
  return task;
}

async function showHoverCard(item, anchorEl) {
  if (!hoverCard) return;
  activeHoverDid = item.did;

  const rawItem = getFollowing(item.did) || item;
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

  const rawItem = getFollowing(item.did) || item;
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
