// Pure scoring, filtering, sorting, and sanitization helpers for ByeSky.

export const SEVERE_LABELS = new Set([
  'spam',
  'impersonation',
  'scam',
  'deceptive',
  'misleading',
  'harassment',
  'hate',
  'intolerance',
  'threat',
  'rude',
  'abuse',
  'violation',
  'banned',
  'suspended',
]);

export function isSevereLabel(labelVal) {
  if (!labelVal) return false;
  const val = labelVal.toLowerCase();
  // Protocol global severe actions (e.g. !hide, !warn)
  if (val === '!hide' || val === '!warn') return true;
  return SEVERE_LABELS.has(val);
}

export function atUriToBskyUrl(atUri) {
  if (!atUri || !atUri.startsWith('at://')) return null;
  const parts = atUri.replace('at://', '').split('/');
  const did = parts[0];
  const collection = parts[1]; // e.g. app.bsky.feed.post
  const rkey = parts[2]; // e.g. 3mv5fw5biui26
  if (did && collection === 'app.bsky.feed.post' && rkey) {
    return `https://bsky.app/profile/${encodeURIComponent(did)}/post/${encodeURIComponent(rkey)}`;
  }
  return did ? `https://bsky.app/profile/${encodeURIComponent(did)}` : null;
}

export function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(
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

export function sanitizeUrl(url, fallback = '') {
  if (!url || typeof url !== 'string') return fallback;
  const trimmed = url.trim();
  if (trimmed.startsWith('https://') || trimmed.startsWith('http://')) {
    return escapeHTML(trimmed);
  }
  return fallback;
}

export function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return escapeHTML(text);
  const truncated = text.substring(0, maxLength - 3) + '...';
  return `<abbr title="${escapeHTML(text)}" style="text-decoration: none; cursor: help; border-bottom: none;">${escapeHTML(truncated)}</abbr>`;
}

export function isUserNeverPosted(item) {
  return !item.criteria?.lastPostDate;
}

export function isUserInactive(item, inactiveDays = 180, now = Date.now()) {
  if (item.criteria?.lastPostDate) {
    const lastPost = new Date(item.criteria.lastPostDate).getTime();
    const daysSincePost = (now - lastPost) / (1000 * 60 * 60 * 24);
    return daysSincePost > inactiveDays;
  }
  return false; // Accounts with no posts are handled distinctly by isUserNeverPosted
}

export function isUserNoisy(item, noisyPostsThreshold = 20) {
  const threshold = noisyPostsThreshold || 20;
  if (item.criteria.postsCount7Days !== undefined) {
    return item.criteria.postsCount7Days >= threshold;
  }
  return !!item.criteria.isNoisy;
}

export function isUserMassFollower(item, massFollowerThreshold = 3500) {
  const threshold = massFollowerThreshold || 3500;
  if (item.criteria.followsCount !== undefined) {
    return item.criteria.followsCount >= threshold;
  }
  return !!item.criteria.isMassFollower;
}

export function calculateScore(item, weights, params, now = Date.now()) {
  let score = 0;

  if (item.criteria.isDeleted || item.criteria.isBanned) {
    score += weights.deletedBanned;
  }

  if (!item.criteria.isFollowingUser) {
    score += weights.notFollowing;
  }

  if (isUserNeverPosted(item)) {
    score += weights.neverPosted !== undefined ? weights.neverPosted : weights.inactive;
  } else if (isUserInactive(item, params.inactiveDays, now)) {
    score += weights.inactive;
  }

  const hasInbound =
    item.criteria.hasLikedUser ||
    item.criteria.hasRepostedUser ||
    item.criteria.hasRepliedToUser ||
    item.criteria.hasMessagedUser ||
    item.criteria.userInteracted;
  if (!hasInbound) {
    score += weights.noInbound;
  }

  const hasOutbound = item.criteria.userContactedThem;
  if (!hasOutbound) {
    score += weights.noOutbound;
  }

  if (item.criteria.isBlocking || item.criteria.isBlocked) {
    score += weights.blocking;
  }

  if (isUserNoisy(item, params.noisyPostsThreshold)) {
    score += weights.noisy;
  }

  if (item.criteria.isMuted) {
    score += weights.muted;
  }

  if (isUserMassFollower(item, params.massFollowerThreshold)) {
    score += weights.massFollower;
  }

  if (item.criteria.isSpammyRatio) {
    score += weights.spammyRatio;
  }

  if (item.criteria.isFlagged) {
    score += weights.flagged;
  }

  if (item.criteria.isOutlier) {
    score += weights.outlier;
  }

  return score;
}

export function filterAndSortFollowings(
  followings,
  { searchQuery, weights, filters, params, sorting, lockedDids },
  now = Date.now(),
) {
  let lockedSet = new Set();
  if (lockedDids instanceof Set) {
    lockedSet = lockedDids;
  } else if (Array.isArray(lockedDids)) {
    lockedSet = new Set(lockedDids);
  }
  const showLocked = filters.locked !== undefined ? filters.locked : true;
  const showNeverPosted = filters.neverPosted !== undefined ? filters.neverPosted : true;

  return followings
    .map((item) => {
      const score = calculateScore(item, weights, params, now);
      const neverPosted = isUserNeverPosted(item);
      const dynamicInactive = isUserInactive(item, params.inactiveDays, now);
      const isLocked = lockedSet.has(item.did);
      return { ...item, score, neverPosted, dynamicInactive, isLocked };
    })
    .filter((item) => {
      // Search
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const nMatch = item.displayName && item.displayName.toLowerCase().includes(q);
        const hMatch = item.handle && item.handle.toLowerCase().includes(q);
        if (!nMatch && !hMatch) return false;
      }

      // Locked / Protected accounts filter
      if (item.isLocked) {
        return showLocked;
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
        neverPosted: item.neverPosted,
        inactive: item.dynamicInactive,
        noInbound: !hasInbound,
        noOutbound: !hasOutbound,
        deletedBanned: !!(item.criteria.isDeleted || item.criteria.isBanned),
        blocking: !!(item.criteria.isBlocking || item.criteria.isBlocked),
        lowFollowers: item.criteria.followersCount < params.lowFollowersThreshold,
        noisy: isUserNoisy(item, params.noisyPostsThreshold),
        muted: !!item.criteria.isMuted,
        massFollower: isUserMassFollower(item, params.massFollowerThreshold),
        spammyRatio: !!item.criteria.isSpammyRatio,
        flagged: !!item.criteria.isFlagged,
        outlier: !!item.criteria.isOutlier,
      };

      // Account has "OK" status if it has none of the warning/inactive flags
      const isOk =
        !criteriaMatches.notFollowing &&
        !criteriaMatches.neverPosted &&
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

      if (isOk && filters.ok) matchesFilter = true;
      if (criteriaMatches.notFollowing && filters.notFollowing) matchesFilter = true;
      if (criteriaMatches.neverPosted && showNeverPosted) matchesFilter = true;
      if (criteriaMatches.inactive && filters.inactive) matchesFilter = true;
      if (criteriaMatches.noInbound && filters.noInbound) matchesFilter = true;
      if (criteriaMatches.noOutbound && filters.noOutbound) matchesFilter = true;
      if (criteriaMatches.deletedBanned && filters.deletedBanned) matchesFilter = true;
      if (criteriaMatches.blocking && filters.blocking) matchesFilter = true;
      if (criteriaMatches.lowFollowers && filters.lowFollowers) matchesFilter = true;
      if (criteriaMatches.noisy && filters.noisy) matchesFilter = true;
      if (criteriaMatches.muted && filters.muted) matchesFilter = true;
      if (criteriaMatches.massFollower && filters.massFollower) matchesFilter = true;
      if (criteriaMatches.spammyRatio && filters.spammyRatio) matchesFilter = true;
      if (criteriaMatches.flagged && filters.flagged) matchesFilter = true;
      if (criteriaMatches.outlier && filters.outlier) matchesFilter = true;

      return matchesFilter;
    })
    .sort((a, b) => {
      let valA, valB;
      if (sorting.col === 'followers') {
        valA = a.criteria.followersCount;
        valB = b.criteria.followersCount;
      } else if (sorting.col === 'lastPost') {
        valA = a.criteria.lastPostDate ? new Date(a.criteria.lastPostDate).getTime() : 0;
        valB = b.criteria.lastPostDate ? new Date(b.criteria.lastPostDate).getTime() : 0;
      } else if (sorting.col === 'lastInteraction') {
        const dateA = a.criteria.lastInteraction?.date || a.criteria.lastLikeDate;
        const dateB = b.criteria.lastInteraction?.date || b.criteria.lastLikeDate;
        valA = dateA ? new Date(dateA).getTime() : 0;
        valB = dateB ? new Date(dateB).getTime() : 0;
      } else if (sorting.col === 'score') {
        valA = a.score;
        valB = b.score;
      }

      if (valA < valB) return sorting.order === 'asc' ? -1 : 1;
      if (valA > valB) return sorting.order === 'asc' ? 1 : -1;
      return 0;
    });
}
