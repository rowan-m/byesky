import test from 'node:test';
import assert from 'node:assert';
import {
  isSevereLabel,
  atUriToBskyUrl,
  escapeHTML,
  sanitizeUrl,
  truncateText,
  isUserNeverPosted,
  isUserInactive,
  isUserNoisy,
  isUserMassFollower,
  calculateScore,
  filterAndSortFollowings,
  summariseAuthorActivity,
  evaluateCriteria,
  isEvaluationOk,
  clampParam,
  prepareFollowing,
} from '../src/scoring.js';

const defaultWeights = {
  notFollowing: 1,
  inactive: 3,
  neverPosted: 4,
  noInbound: 1,
  noOutbound: 5,
  deletedBanned: 4,
  blocking: 4,
  noisy: 1,
  muted: 4,
  massFollower: 1,
  spammyRatio: 1,
  flagged: 3,
  outlier: 1,
};

const defaultParams = {
  inactiveDays: 180,
  lowFollowersThreshold: 50,
  noisyPostsThreshold: 20,
  massFollowerThreshold: 3500,
};

const defaultFilters = {
  ok: true,
  notFollowing: true,
  inactive: true,
  neverPosted: true,
  noInbound: true,
  noOutbound: true,
  deletedBanned: true,
  blocking: true,
  lowFollowers: true,
  noisy: true,
  muted: true,
  massFollower: true,
  spammyRatio: true,
  flagged: true,
  outlier: true,
};

test('Scoring & Sanitization Helpers', async (t) => {
  await t.test('escapeHTML and sanitizeUrl protect against attribute/XSS injection', () => {
    assert.strictEqual(
      escapeHTML('<script>"alert(1)"</script>'),
      '&lt;script&gt;&quot;alert(1)&quot;&lt;/script&gt;',
    );
    assert.strictEqual(
      sanitizeUrl('https://cdn.bsky.app/img/avatar" onerror="alert(1)', 'fallback'),
      'https://cdn.bsky.app/img/avatar&quot; onerror=&quot;alert(1)',
    );
    assert.strictEqual(sanitizeUrl('javascript:alert(1)', 'fallback'), 'fallback');
    assert.strictEqual(sanitizeUrl('http://example.com/a.png', 'fallback'), 'fallback');
    assert.strictEqual(
      truncateText('VeryLongDisplayName', 10),
      '<abbr class="truncated-text" title="VeryLongDisplayName">VeryLon...</abbr>',
    );
  });

  await t.test('isSevereLabel and atUriToBskyUrl handle ATProto primitives', () => {
    assert.strictEqual(isSevereLabel('spam'), true);
    assert.strictEqual(isSevereLabel('!hide'), true);
    assert.strictEqual(isSevereLabel('custom-benign'), false);

    assert.strictEqual(
      atUriToBskyUrl('at://did:plc:abc123/app.bsky.feed.post/3kxyz'),
      'https://bsky.app/profile/did%3Aplc%3Aabc123/post/3kxyz',
    );
  });

  await t.test(
    'calculateScore applies additive deletedBanned weight so deleted accounts score highest',
    () => {
      const now = Date.now();
      const deletedAccount = {
        did: 'did:plc:deleted',
        criteria: {
          isDeleted: true,
          isBanned: false,
          isFollowingUser: false,
          lastPostDate: null,
          hasLikedUser: false,
          userContactedThem: false,
        },
      };
      const activeLurker = {
        did: 'did:plc:lurker',
        criteria: {
          isDeleted: false,
          isBanned: false,
          isFollowingUser: false,
          lastPostDate: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
          hasLikedUser: false,
          userContactedThem: false,
        },
      };

      const deletedScore = calculateScore(deletedAccount, defaultWeights, defaultParams, now);
      const lurkerScore = calculateScore(activeLurker, defaultWeights, defaultParams, now);

      // Deleted account gets deletedBanned(4) + notFollowing(1) + neverPosted(4) + noInbound(1) + noOutbound(5) = 15
      assert.strictEqual(deletedScore, 15);
      // Active lurker gets notFollowing(1) + noInbound(1) + noOutbound(5) = 7
      assert.strictEqual(lurkerScore, 7);
      assert.ok(deletedScore > lurkerScore);
    },
  );

  await t.test('scores neverPosted and inactive accounts distinctly without overlap', () => {
    const now = Date.now();
    const neverPostedAccount = {
      did: 'did:plc:never',
      criteria: {
        isFollowingUser: true,
        lastPostDate: null,
        hasLikedUser: true,
        userContactedThem: true,
      },
    };
    const inactiveAccount = {
      did: 'did:plc:inactive',
      criteria: {
        isFollowingUser: true,
        lastPostDate: new Date(now - 365 * 24 * 60 * 60 * 1000).toISOString(),
        hasLikedUser: true,
        userContactedThem: true,
      },
    };

    assert.strictEqual(isUserNeverPosted(neverPostedAccount), true);
    assert.strictEqual(isUserInactive(neverPostedAccount, 180, now), false);
    assert.strictEqual(isUserNeverPosted(inactiveAccount), false);
    assert.strictEqual(isUserInactive(inactiveAccount, 180, now), true);

    const customWeights = { ...defaultWeights, inactive: 2, neverPosted: 5 };
    assert.strictEqual(calculateScore(neverPostedAccount, customWeights, defaultParams, now), 5);
    assert.strictEqual(calculateScore(inactiveAccount, customWeights, defaultParams, now), 2);
  });

  await t.test('filterAndSortFollowings filters and sorts accurately by score descending', () => {
    const now = Date.now();
    const list = [
      {
        did: 'did:plc:clean',
        handle: 'clean.bsky.social',
        displayName: 'Clean User',
        criteria: {
          isDeleted: false,
          isBanned: false,
          isFollowingUser: true,
          lastPostDate: new Date(now - 1000).toISOString(),
          hasLikedUser: true,
          userContactedThem: true,
          followersCount: 500,
          followsCount: 200,
          postsCount7Days: 5,
        },
      },
      {
        did: 'did:plc:banned',
        handle: 'banned.bsky.social',
        displayName: 'Banned User',
        criteria: {
          isDeleted: false,
          isBanned: true,
          isFollowingUser: false,
          lastPostDate: null,
          hasLikedUser: false,
          userContactedThem: false,
          followersCount: 10,
          followsCount: 10,
          postsCount7Days: 0,
        },
      },
    ];

    const sorted = filterAndSortFollowings(
      list,
      {
        searchQuery: '',
        weights: defaultWeights,
        filters: defaultFilters,
        params: defaultParams,
        sorting: { col: 'score', order: 'desc' },
      },
      now,
    );

    assert.strictEqual(sorted.length, 2);
    assert.strictEqual(sorted[0].did, 'did:plc:banned');
    assert.strictEqual(sorted[1].did, 'did:plc:clean');
    assert.strictEqual(sorted[1].score, 0);

    // Check helper thresholds
    assert.strictEqual(isUserInactive(list[0], 180, now), false);
    assert.strictEqual(isUserNoisy(list[0], 20), false);
    assert.strictEqual(isUserMassFollower(list[0], 3500), false);

    // Verify lockedDids filtering: when filters.locked is false, locked accounts are hidden even if they have warning flags
    const hiddenLocked = filterAndSortFollowings(
      list,
      {
        searchQuery: '',
        weights: defaultWeights,
        filters: { ...defaultFilters, locked: false },
        params: defaultParams,
        sorting: { col: 'score', order: 'desc' },
        lockedDids: new Set(['did:plc:banned']),
      },
      now,
    );
    assert.strictEqual(hiddenLocked.length, 1);
    assert.strictEqual(hiddenLocked[0].did, 'did:plc:clean');
  });

  await t.test('summariseAuthorActivity counts posts, replies and reposts', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    const iso = (daysAgo) => new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    const post = (uri, daysAgo, extra = {}) => ({
      uri,
      indexedAt: iso(daysAgo),
      record: { text: `text ${uri}` },
      author: { handle: 'someone.else' },
      ...extra,
    });

    // Repost-only account (profile postsCount would be 0): the repost is dated by when it
    // was reposted, not when the original was written 400 days ago.
    const repostOnly = summariseAuthorActivity(
      [
        {
          post: post('at://did:plc:orig/app.bsky.feed.post/1', 400),
          reason: { $type: 'app.bsky.feed.defs#reasonRepost', indexedAt: iso(2) },
        },
      ],
      now,
    );
    assert.strictEqual(repostOnly.lastPostDate, iso(2));
    assert.strictEqual(repostOnly.lastPost.kind, 'repost');
    assert.strictEqual(repostOnly.lastPost.originalAuthor, 'someone.else');
    assert.strictEqual(repostOnly.postsCount7Days, 1);

    // Reply-only account counts as active, and replies count towards the 7-day total.
    const replies = summariseAuthorActivity(
      [
        { post: post('at://did:plc:me/app.bsky.feed.post/2', 1), reply: { parent: {} } },
        { post: post('at://did:plc:me/app.bsky.feed.post/3', 3), reply: { parent: {} } },
        { post: post('at://did:plc:me/app.bsky.feed.post/4', 10) },
      ],
      now,
    );
    assert.strictEqual(replies.lastPost.kind, 'reply');
    assert.strictEqual(replies.lastPostDate, iso(1));
    assert.strictEqual(replies.postsCount7Days, 2);

    // Newest item wins even if the feed isn't strictly ordered; pins are ignored.
    const mixed = summariseAuthorActivity(
      [
        {
          post: post('at://did:plc:me/app.bsky.feed.post/pinned', 0),
          reason: { $type: 'app.bsky.feed.defs#reasonPin' },
        },
        { post: post('at://did:plc:me/app.bsky.feed.post/5', 5) },
        { post: post('at://did:plc:me/app.bsky.feed.post/6', 4) },
      ],
      now,
    );
    assert.strictEqual(mixed.lastPost.kind, 'post');
    assert.strictEqual(mixed.lastPostDate, iso(4));
    assert.strictEqual(mixed.postsCount7Days, 2);

    // Empty feed means never posted.
    const empty = summariseAuthorActivity([], now);
    assert.deepStrictEqual(empty, { lastPostDate: null, lastPost: null, postsCount7Days: 0 });
    assert.strictEqual(isUserNeverPosted({ criteria: { lastPostDate: empty.lastPostDate } }), true);
    assert.strictEqual(
      isUserNeverPosted({ criteria: { lastPostDate: repostOnly.lastPostDate } }),
      false,
    );
  });

  await t.test('failed fetches make criteria unknown instead of negative', () => {
    const now = Date.now();
    const item = {
      did: 'did:plc:unknown',
      criteria: {
        isFollowingUser: true,
        lastPostDate: null,
        postsCount7Days: 0,
        followersCount: 0,
        followsCount: 0,
        unknown: ['activity', 'profile', 'inbound', 'outbound'],
      },
    };
    const { matches, unknownSources } = evaluateCriteria(item, defaultParams, now);
    for (const id of [
      'neverPosted',
      'inactive',
      'noisy',
      'lowFollowers',
      'muted',
      'noInbound',
      'noOutbound',
    ]) {
      assert.strictEqual(matches[id], null, id);
    }
    assert.deepStrictEqual(unknownSources.sort(), ['activity', 'inbound', 'outbound', 'profile']);
    assert.strictEqual(
      calculateScore(item, { ...defaultWeights, lowFollowers: 5 }, defaultParams, now),
      0,
    );

    // Contact that was found still counts even if another scan failed.
    const contacted = evaluateCriteria(
      {
        criteria: { hasLikedUser: true, userContactedThem: true, unknown: ['inbound', 'outbound'] },
      },
      defaultParams,
      now,
    );
    assert.strictEqual(contacted.matches.noInbound, false);
    assert.strictEqual(contacted.matches.noOutbound, false);

    // Mutuals that weren't looked up are unknown; a looked-up 0 is an outlier.
    assert.strictEqual(evaluateCriteria({ criteria: {} }).matches.outlier, null);
    assert.strictEqual(evaluateCriteria({ criteria: { mutualsCount: 0 } }).matches.outlier, true);

    // Unknown criteria never match a filter.
    const shown = filterAndSortFollowings(
      [
        {
          did: 'did:plc:unknown',
          handle: 'u',
          criteria: {
            ...item.criteria,
            hasLikedUser: true,
            userContactedThem: true,
            mutualsCount: 3,
          },
        },
      ],
      {
        searchQuery: '',
        weights: defaultWeights,
        filters: {
          ...Object.fromEntries(Object.keys(defaultFilters).map((k) => [k, false])),
          neverPosted: false,
          lowFollowers: true,
        },
        params: defaultParams,
        sorting: { col: 'score', order: 'desc' },
      },
      now,
    );
    assert.strictEqual(shown.length, 0);
  });

  await t.test('OK ignores zero-weight criteria so the badge and filter agree', () => {
    const now = Date.now();
    const item = {
      did: 'did:plc:small',
      criteria: {
        isFollowingUser: true,
        lastPostDate: new Date(now - 1000).toISOString(),
        postsCount7Days: 1,
        hasLikedUser: true,
        userContactedThem: true,
        followersCount: 10,
        followsCount: 10,
        mutualsCount: 4,
      },
    };
    const evaluation = evaluateCriteria(item, defaultParams, now);
    assert.strictEqual(evaluation.matches.lowFollowers, true);
    assert.strictEqual(isEvaluationOk(evaluation, { ...defaultWeights, lowFollowers: 0 }), true);
    assert.strictEqual(isEvaluationOk(evaluation, { ...defaultWeights, lowFollowers: 1 }), false);

    const [row] = filterAndSortFollowings(
      [{ ...item, handle: 'small' }],
      {
        searchQuery: '',
        weights: { ...defaultWeights, lowFollowers: 0 },
        filters: { ...defaultFilters, lowFollowers: false },
        params: defaultParams,
        sorting: { col: 'score', order: 'desc' },
      },
      now,
    );
    assert.strictEqual(row.isOk, true);
    assert.strictEqual(row.score, 0);
  });

  await t.test('clampParam keeps 0, clamps to bounds and defaults junk', () => {
    assert.strictEqual(clampParam('lowFollowersThreshold', '0'), 0);
    assert.strictEqual(clampParam('lowFollowersThreshold', ''), 50);
    assert.strictEqual(clampParam('noisyPostsThreshold', '500'), 100);
    assert.strictEqual(clampParam('noisyPostsThreshold', '0'), 1);
    assert.strictEqual(clampParam('inactiveDays', 'abc'), 180);
    assert.strictEqual(clampParam('massFollowerThreshold', 50), 100);
  });

  await t.test('prepareFollowing precomputes timestamps and search text', () => {
    const postDate = '2026-01-15T12:00:00.000Z';
    const interactionDate = '2026-02-01T08:30:00.000Z';
    const item = prepareFollowing({
      did: 'did:plc:prep',
      handle: 'Alice.BSKY.Social',
      displayName: 'Alice Example',
      criteria: {
        lastPostDate: postDate,
        lastInteraction: { date: interactionDate, type: 'like' },
      },
    });
    assert.strictEqual(item._lastPostMs, Date.parse(postDate));
    assert.strictEqual(item._lastInteractionMs, Date.parse(interactionDate));
    assert.strictEqual(item._searchText, 'alice.bsky.social\nalice example');
  });
});
