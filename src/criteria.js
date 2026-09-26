// The single description of every unfollow criterion: its default weight, the controls
// that drive it in index.html, and the badges shown when it matches. State defaults, the
// criteria panel wiring and the row badges are all derived from this list, so adding a
// criterion means adding an entry here, its evaluation in scoring.js and its markup.

import { formatCount } from './app/format.js';

// Keep in step with SCAN_LIMIT in atproto.js (not imported so the API bundle stays lazy).
export const SCAN_LIMIT_LABEL = '2,500';

/**
 * Criteria in the order their badges are shown. Each badge is shown when its criterion
 * matches, unless it has a `when(item)` that narrows it further (e.g. deleted vs banned).
 * `title(item, params)` receives the row's item and the current threshold params.
 */
export const CRITERIA = [
  {
    id: 'deletedBanned',
    defaultWeight: 4,
    filterId: 'filter-deleted-banned',
    weightId: 'weight-deleted-banned',
    badges: [
      {
        kind: 'danger',
        label: 'DELETED',
        title: () => 'This account has been deleted or deactivated',
        when: (item) => Boolean(item.criteria.isDeleted),
      },
      {
        kind: 'danger',
        label: 'BANNED',
        title: () => 'This account has been taken down by Bluesky',
        when: (item) => Boolean(item.criteria.isBanned),
      },
    ],
  },
  {
    id: 'blocking',
    defaultWeight: 4,
    filterId: 'filter-blocking',
    weightId: 'weight-blocking',
    badges: [
      {
        kind: 'danger',
        label: 'BLOCK',
        title: (item) =>
          item.criteria.isBlocked ? 'This account blocks you' : 'You block this account',
      },
    ],
  },
  {
    id: 'neverPosted',
    defaultWeight: 4,
    filterId: 'filter-never-posted',
    weightId: 'weight-never-posted',
    badges: [
      {
        kind: 'warning',
        label: 'NEVER POSTED',
        title: () => 'Never Posted: No posts, replies or reposts found for this account',
      },
    ],
  },
  {
    id: 'inactive',
    defaultWeight: 3,
    filterId: 'filter-inactive',
    weightId: 'weight-inactive',
    badges: [
      {
        kind: 'warning',
        label: 'INACTIVE',
        title: (item, params) =>
          `Inactive: No posts, replies or reposts in the last ${params.inactiveDays} days`,
      },
    ],
  },
  {
    id: 'notFollowing',
    defaultWeight: 1,
    filterId: 'filter-not-following',
    weightId: 'weight-not-following',
    badges: [
      {
        kind: 'secondary',
        label: 'NO FOLLOW',
        title: () => 'This account does not follow you back',
      },
    ],
  },
  {
    id: 'noInbound',
    defaultWeight: 1,
    filterId: 'filter-no-inbound',
    weightId: 'weight-no-inbound',
    badges: [
      {
        kind: 'secondary',
        label: 'NO INBOUND',
        title: () =>
          `They have not liked, reposted, replied, quoted or messaged you recently (scanned your last ${SCAN_LIMIT_LABEL} notifications)`,
      },
    ],
  },
  {
    id: 'noOutbound',
    defaultWeight: 5,
    filterId: 'filter-no-outbound',
    weightId: 'weight-no-outbound',
    badges: [
      {
        kind: 'secondary',
        label: 'NO OUTBOUND',
        title: () =>
          `You have not liked, replied to, reposted, quoted or messaged them recently (scanned your last ${SCAN_LIMIT_LABEL} posts and likes)`,
      },
    ],
  },
  {
    id: 'noisy',
    defaultWeight: 1,
    filterId: 'filter-noisy',
    weightId: 'weight-noisy',
    badges: [
      {
        kind: 'warning',
        label: 'NOISY',
        title: (item) =>
          `Noisy Poster: ${item.criteria.postsCount7Days ?? 'Many'} posts, replies and reposts in the last 7 days`,
      },
    ],
  },
  {
    id: 'muted',
    defaultWeight: 4,
    filterId: 'filter-muted',
    weightId: 'weight-muted',
    badges: [
      {
        kind: 'danger',
        label: 'MUTED',
        title: () => 'Muted: You have muted this account on Bluesky',
      },
    ],
  },
  {
    id: 'massFollower',
    defaultWeight: 1,
    filterId: 'filter-mass-follower',
    weightId: 'weight-mass-follower',
    badges: [
      {
        kind: 'warning',
        label: 'MASS FOLLOW',
        title: (item) =>
          `Mass Follower: Follows ${formatCount(item.criteria.followsCount)} accounts on Bluesky`,
      },
    ],
  },
  {
    id: 'spammyRatio',
    defaultWeight: 1,
    filterId: 'filter-spammy-ratio',
    weightId: 'weight-spammy-ratio',
    badges: [
      {
        kind: 'danger',
        label: 'SPAMMY RATIO',
        title: () => 'Spammy Ratio: Follows far more accounts than follow it (follow-back farmer)',
      },
    ],
  },
  {
    id: 'flagged',
    defaultWeight: 3,
    filterId: 'filter-flagged',
    weightId: 'weight-flagged',
    badges: [
      {
        kind: 'danger',
        label: 'FLAGGED',
        title: () => 'Flagged: This account has moderation labels from Bluesky',
      },
    ],
  },
  {
    id: 'lowFollowers',
    defaultWeight: 0,
    filterId: 'filter-low-followers',
    weightId: 'weight-low-followers',
    badges: [
      {
        kind: 'secondary',
        label: 'LOW FOLLOWERS',
        title: (item, params) =>
          `Low Followers: Fewer than ${params.lowFollowersThreshold} followers`,
      },
    ],
  },
  {
    id: 'outlier',
    defaultWeight: 1,
    filterId: 'filter-outlier',
    weightId: 'weight-outlier',
    badges: [
      {
        kind: 'warning',
        label: '0 MUTUALS',
        title: () => 'Social Outlier: None of the accounts you follow follow them',
      },
    ],
  },
];

/** Filters that aren't criteria: accounts that are OK, and accounts the user has locked. */
export const EXTRA_FILTERS = [
  { key: 'ok', filterId: 'filter-ok' },
  { key: 'locked', filterId: 'filter-locked' },
];

/** Every filter checkbox, keyed by its `state.filters` property. */
export const FILTER_CONTROLS = [
  ...EXTRA_FILTERS,
  ...CRITERIA.map(({ id, filterId }) => ({ key: id, filterId })),
];

export function defaultWeights() {
  return Object.fromEntries(CRITERIA.map(({ id, defaultWeight }) => [id, defaultWeight]));
}

/** Everything is shown by default. */
export function defaultFilters() {
  return Object.fromEntries(FILTER_CONTROLS.map(({ key }) => [key, true]));
}

/**
 * The negative badges for an account, in display order, as `{ kind, title, label }`.
 * Criteria that are unknown (null) or don't match produce nothing.
 */
export function negativeBadges(item, params) {
  const out = [];
  for (const criterion of CRITERIA) {
    if (item.evaluation.matches[criterion.id] !== true) continue;
    for (const b of criterion.badges) {
      if (b.when && !b.when(item)) continue;
      out.push({ kind: b.kind, title: b.title(item, params), label: b.label });
    }
  }
  return out;
}
