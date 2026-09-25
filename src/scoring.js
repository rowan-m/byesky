// Pure scoring, filtering, sorting, and sanitization helpers for ByeSky.

import { CRITERIA } from './criteria.js';

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
  if (trimmed.startsWith('https://')) {
    return escapeHTML(trimmed);
  }
  return fallback;
}

export function truncateText(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return escapeHTML(text);
  const truncated = text.substring(0, maxLength - 3) + '...';
  return `<abbr class="truncated-text" title="${escapeHTML(text)}">${escapeHTML(truncated)}</abbr>`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function feedItemKind(item) {
  if (item.reason?.$type?.includes('reasonRepost')) return 'repost';
  if (item.reply || item.post?.record?.reply) return 'reply';
  return 'post';
}

/**
 * Summarises an author feed into posting-activity criteria. The feed should be fetched
 * without a filter so it includes posts, replies and reposts, all of which count as
 * activity. Reposts are dated by when the account reposted, not when the original was
 * posted. Pinned items are ignored because they aren't a signal of recent activity.
 */
export function summariseAuthorActivity(feed = [], now = Date.now()) {
  const sevenDaysAgo = now - 7 * DAY_MS;
  let latest = null;
  let count7Days = 0;

  for (const item of feed) {
    if (!item?.post || item.reason?.$type?.includes('reasonPin')) continue;
    const kind = feedItemKind(item);
    const date =
      kind === 'repost'
        ? item.reason.indexedAt || item.post.indexedAt
        : item.post.indexedAt || item.post.record?.createdAt;
    const time = date ? new Date(date).getTime() : Number.NaN;
    if (Number.isNaN(time)) continue;

    if (time > sevenDaysAgo) count7Days++;
    if (!latest || time > latest.time) latest = { time, date, kind, post: item.post };
  }

  if (!latest) return { lastPostDate: null, lastPost: null, postsCount7Days: 0 };

  const { post } = latest;
  return {
    lastPostDate: latest.date,
    postsCount7Days: count7Days,
    lastPost: {
      kind: latest.kind,
      text: (post.record?.text || '').slice(0, 280),
      uri: atUriToBskyUrl(post.uri),
      date: latest.date,
      // For reposts, whose post it was (the account being previewed didn't write it).
      originalAuthor: latest.kind === 'repost' ? post.author?.handle || null : null,
      likeCount: post.likeCount || 0,
      repostCount: post.repostCount || 0,
    },
  };
}

/**
 * Bounds and defaults for the user-editable thresholds. Inputs are clamped to these so a
 * typo can't silently switch a criterion off, and 0 stays 0 rather than becoming the default.
 */
export const PARAM_LIMITS = {
  inactiveDays: { min: 7, max: 730, default: 180 },
  lowFollowersThreshold: { min: 0, max: 100000, default: 50 },
  noisyPostsThreshold: { min: 1, max: 100, default: 20 },
  massFollowerThreshold: { min: 100, max: 100000, default: 3500 },
};

export function clampParam(key, value) {
  const limits = PARAM_LIMITS[key];
  const n = typeof value === 'number' ? Math.trunc(value) : Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return limits.default;
  return Math.min(limits.max, Math.max(limits.min, n));
}

function normaliseParams(params = {}) {
  const out = {};
  for (const key of Object.keys(PARAM_LIMITS)) out[key] = clampParam(key, params[key]);
  return out;
}

/**
 * The criteria, in the order their badges are shown (see criteria.js). Each one evaluates
 * to true (matches), false (doesn't) or null (unknown, because the data behind it couldn't
 * be fetched).
 */
export const CRITERIA_IDS = CRITERIA.map(({ id }) => id);

/**
 * Data sources a sync can fail to fetch for an account. Stored in `criteria.unknown` so
 * criteria that depend on them are treated as unknown instead of as a negative signal.
 */
export const UNKNOWN_SOURCE_LABELS = {
  profile: 'profile statistics',
  activity: 'recent posts',
  inbound: 'notifications and DMs',
  outbound: 'your posts and likes',
};

// Contact found is definite; no contact found only counts if the scan that looks for it worked.
function noContact(found, scanFailed) {
  if (found) return false;
  return scanFailed ? null : true;
}

function hasInboundContact(c) {
  return !!(
    c.hasLikedUser ||
    c.hasRepostedUser ||
    c.hasRepliedToUser ||
    c.hasMessagedUser ||
    c.userInteracted
  );
}

/**
 * Evaluates every criterion for an account. This is the single source of truth for the
 * score, the filters and the badges, so they can't disagree.
 */
export function evaluateCriteria(item, params = {}, now = Date.now()) {
  const c = item.criteria || {};
  const p = normaliseParams(params);
  const unknown = new Set(Array.isArray(c.unknown) ? c.unknown : []);
  const activityKnown = !unknown.has('activity');
  const profileKnown = !unknown.has('profile');

  let inactive = null;
  if (activityKnown) {
    const postMs =
      item._lastPostMs !== undefined
        ? item._lastPostMs
        : c.lastPostDate
          ? Date.parse(c.lastPostDate) || 0
          : 0;
    inactive = postMs > 0 ? (now - postMs) / DAY_MS > p.inactiveDays : false;
  }

  let noisy = null;
  if (activityKnown) {
    noisy =
      typeof c.postsCount7Days === 'number'
        ? c.postsCount7Days >= p.noisyPostsThreshold
        : !!c.isNoisy;
  }

  let massFollower = null;
  if (profileKnown) {
    massFollower =
      typeof c.followsCount === 'number'
        ? c.followsCount >= p.massFollowerThreshold
        : !!c.isMassFollower;
  }

  const hasInbound = hasInboundContact(c);
  const hasOutbound = !!c.userContactedThem;
  const mutualsKnown = typeof c.mutualsCount === 'number';

  const matches = {
    deletedBanned: !!(c.isDeleted || c.isBanned),
    blocking: !!(c.isBlocking || c.isBlocked),
    neverPosted: activityKnown ? !c.lastPostDate : null,
    inactive,
    notFollowing: !c.isFollowingUser,
    noInbound: noContact(hasInbound, unknown.has('inbound')),
    noOutbound: noContact(hasOutbound, unknown.has('outbound')),
    noisy,
    muted: profileKnown ? !!c.isMuted : null,
    massFollower,
    spammyRatio: profileKnown ? !!c.isSpammyRatio : null,
    flagged: profileKnown ? !!c.isFlagged : null,
    outlier: mutualsKnown ? c.mutualsCount === 0 : null,
    lowFollowers:
      profileKnown && typeof c.followersCount === 'number'
        ? c.followersCount < p.lowFollowersThreshold
        : null,
  };

  return {
    matches,
    hasInbound,
    hasOutbound,
    // Sources that failed, for the "data incomplete" badge. Skipped mutuals aren't a failure.
    unknownSources: [...unknown].filter((s) => s in UNKNOWN_SOURCE_LABELS),
  };
}

function weightFor(id, weights) {
  if (id === 'neverPosted') return weights.neverPosted ?? weights.inactive ?? 0;
  return weights[id] ?? 0;
}

export function scoreEvaluation(evaluation, weights) {
  let score = 0;
  for (const id of CRITERIA_IDS) {
    if (evaluation.matches[id] === true) score += weightFor(id, weights);
  }
  return score;
}

/**
 * An account is OK when nothing that carries weight matches. Criteria the user has set to
 * weight 0 are informational only, and unknown criteria never count against an account.
 */
export function isEvaluationOk(evaluation, weights) {
  return CRITERIA_IDS.every(
    (id) => evaluation.matches[id] !== true || weightFor(id, weights) === 0,
  );
}

export function isUserNeverPosted(item) {
  return evaluateCriteria(item).matches.neverPosted === true;
}

export function isUserInactive(item, inactiveDays = 180, now = Date.now()) {
  return evaluateCriteria(item, { inactiveDays }, now).matches.inactive === true;
}

export function isUserNoisy(item, noisyPostsThreshold = 20) {
  return evaluateCriteria(item, { noisyPostsThreshold }).matches.noisy === true;
}

export function isUserMassFollower(item, massFollowerThreshold = 3500) {
  return evaluateCriteria(item, { massFollowerThreshold }).matches.massFollower === true;
}

export function calculateScore(item, weights, params, now = Date.now()) {
  return scoreEvaluation(evaluateCriteria(item, params, now), weights);
}

/**
 * Precomputes parsed timestamps and lowercase search text on an item when followings are
 * loaded, avoiding repeated Date.parse() and toLowerCase() work during filtering/sorting.
 */
export function prepareFollowing(item) {
  const c = item.criteria || {};
  const interactionDate = c.lastInteraction?.date || c.lastLikeDate;
  item._lastPostMs = c.lastPostDate ? Date.parse(c.lastPostDate) || 0 : 0;
  item._lastInteractionMs = interactionDate ? Date.parse(interactionDate) || 0 : 0;
  item._searchText = `${(item.handle || '').toLowerCase()}\n${(item.displayName || '').toLowerCase()}`;
  return item;
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
  const showLocked = filters.locked ?? true;
  const activeFilters = { ...filters, neverPosted: filters.neverPosted ?? true };
  const queryLower = searchQuery ? searchQuery.toLowerCase() : '';

  const filtered = [];
  for (const item of followings) {
    if (queryLower) {
      const haystack =
        item._searchText ??
        `${(item.handle || '').toLowerCase()}\n${(item.displayName || '').toLowerCase()}`;
      if (!haystack.includes(queryLower)) continue;
    }

    const isLocked = lockedSet.has(item.did);
    if (isLocked && !showLocked) continue;

    const evaluation = evaluateCriteria(item, params, now);
    const isOk = isEvaluationOk(evaluation, weights);

    // Shown if it's locked (and showLocked is true), or if it's OK and OK is ticked,
    // or if it matches at least one ticked criterion. Unknown (null) criteria never match.
    const matchesFilter =
      isLocked ||
      (isOk && activeFilters.ok) ||
      CRITERIA_IDS.some((id) => activeFilters[id] && evaluation.matches[id] === true);
    if (!matchesFilter) continue;

    const score = scoreEvaluation(evaluation, weights);
    filtered.push({
      ...item,
      score,
      evaluation,
      isOk,
      neverPosted: evaluation.matches.neverPosted === true,
      dynamicInactive: evaluation.matches.inactive === true,
      isLocked,
    });
  }

  return filtered.sort((a, b) => {
    let valA, valB;
    if (sorting.col === 'followers') {
      valA = a.criteria.followersCount ?? 0;
      valB = b.criteria.followersCount ?? 0;
    } else if (sorting.col === 'lastPost') {
      valA =
        a._lastPostMs ?? (a.criteria.lastPostDate ? Date.parse(a.criteria.lastPostDate) || 0 : 0);
      valB =
        b._lastPostMs ?? (b.criteria.lastPostDate ? Date.parse(b.criteria.lastPostDate) || 0 : 0);
    } else if (sorting.col === 'lastInteraction') {
      const dateA = a.criteria.lastInteraction?.date || a.criteria.lastLikeDate;
      const dateB = b.criteria.lastInteraction?.date || b.criteria.lastLikeDate;
      valA = a._lastInteractionMs ?? (dateA ? Date.parse(dateA) || 0 : 0);
      valB = b._lastInteractionMs ?? (dateB ? Date.parse(dateB) || 0 : 0);
    } else if (sorting.col === 'score') {
      valA = a.score;
      valB = b.score;
    }

    if (valA < valB) return sorting.order === 'asc' ? -1 : 1;
    if (valA > valB) return sorting.order === 'asc' ? 1 : -1;
    return 0;
  });
}
