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
    assert.strictEqual(
      truncateText('VeryLongDisplayName', 10),
      '<abbr title="VeryLongDisplayName" style="text-decoration: none; cursor: help; border-bottom: none;">VeryLon...</abbr>',
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
});
