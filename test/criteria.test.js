import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatCount,
  formatLastSynced,
  formatMutualsCount,
  formatRelativeDate,
} from '../src/app/format.js';
import {
  CRITERIA,
  defaultFilters,
  defaultWeights,
  EXTRA_FILTERS,
  FILTER_CONTROLS,
  negativeBadges,
} from '../src/criteria.js';
import { CRITERIA_IDS, evaluateCriteria } from '../src/scoring.js';

describe('criteria config', () => {
  it('defines all 14 criteria in step with CRITERIA_IDS in scoring.js', () => {
    assert.equal(CRITERIA.length, 14);
    assert.deepEqual(
      CRITERIA.map((c) => c.id),
      CRITERIA_IDS,
    );
    const uniqueIds = new Set(CRITERIA_IDS);
    assert.equal(uniqueIds.size, 14);
  });

  it('derives defaultWeights and defaultFilters from the criteria table', () => {
    const weights = defaultWeights();
    assert.equal(Object.keys(weights).length, 14);
    assert.equal(weights.noOutbound, 5);
    assert.equal(weights.lowFollowers, 0);

    const filters = defaultFilters();
    assert.equal(Object.keys(filters).length, CRITERIA.length + EXTRA_FILTERS.length);
    for (const { key } of FILTER_CONTROLS) {
      assert.equal(filters[key], true);
    }
  });

  it('produces negative badges only for matching criteria and respects when() guards', () => {
    const params = {
      inactiveDays: 180,
      lowFollowersThreshold: 50,
      noisyPostsThreshold: 20,
      massFollowerThreshold: 3500,
    };
    const item = {
      criteria: {
        isDeleted: true,
        isBanned: false,
        isBlocked: true,
        isFollowingUser: false,
        lastPostDate: null,
        followersCount: 10,
        followsCount: 5000,
        postsCount7Days: 0,
        isMuted: true,
        isSpammyRatio: true,
        isFlagged: true,
        mutualsCount: 0,
      },
    };
    item.evaluation = evaluateCriteria(item, params);
    const badges = negativeBadges(item, params);
    const labels = badges.map((b) => b.label);

    // Deleted is shown, Banned is not (via when() guard)
    assert.ok(labels.includes('DELETED'));
    assert.ok(!labels.includes('BANNED'));
    assert.ok(labels.includes('BLOCK'));
    assert.equal(badges.find((b) => b.label === 'BLOCK').title, 'This account blocks you');
    assert.ok(labels.includes('NEVER POSTED'));
    assert.ok(!labels.includes('INACTIVE'));
    assert.ok(labels.includes('LOW FOLLOWERS'));
    assert.ok(labels.includes('0 MUTUALS'));
  });
});

describe('format helpers', () => {
  it('formats counts and handles missing numbers', () => {
    assert.equal(formatCount(0), '0');
    assert.equal(formatCount(null), '—');
    assert.equal(formatCount(undefined), '—');
  });

  it('formats mutual follower counts with 10+ cap', () => {
    assert.equal(formatMutualsCount({ mutualsCount: 0 }), '0');
    assert.equal(formatMutualsCount({ mutualsCount: 4 }), '4');
    assert.equal(formatMutualsCount({ mutualsCount: 10, hasMoreMutuals: false }), '10');
    assert.equal(formatMutualsCount({ mutualsCount: 10, hasMoreMutuals: true }), '10+');
    assert.equal(formatMutualsCount({ mutualsCount: 11 }), '10+');
  });

  it('formats relative dates and last synced timestamps', () => {
    assert.equal(formatRelativeDate(null), 'Never');
    assert.equal(formatRelativeDate(new Date().toISOString()), 'Just now');
    assert.equal(
      formatRelativeDate(new Date(Date.now() - 3 * 3600 * 1000).toISOString()),
      '3h ago',
    );
    assert.equal(
      formatRelativeDate(new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
      'Yesterday',
    );
    assert.equal(
      formatRelativeDate(new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString()),
      '5d ago',
    );
    assert.equal(formatLastSynced(null), 'Never synced');
    assert.match(formatLastSynced(Date.now()), /^Last synced: /);
  });
});
