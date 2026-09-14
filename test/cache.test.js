import test from 'node:test';
import assert from 'node:assert';
import { syncCache } from '../src/cache.js';

test('UserSyncCache Core Operations', async (t) => {
  const testDid = 'did:plc:testuser123';

  await t.test('should return default structure for an uninitialized DID', async () => {
    const entry = await syncCache.get(testDid);
    assert.strictEqual(entry.status, 'idle');
    assert.strictEqual(entry.error, null);
    assert.strictEqual(entry.progress.total, 0);
    assert.strictEqual(entry.progress.processed, 0);
    assert.deepEqual(entry.followings, []);
  });

  await t.test('should update progress statistics and stage name correctly', async () => {
    await syncCache.updateProgress(testDid, 10, 100, 'Processing profiles');
    const entry = await syncCache.get(testDid);
    assert.strictEqual(entry.progress.processed, 10);
    assert.strictEqual(entry.progress.total, 100);
    assert.strictEqual(entry.progress.currentStage, 'Processing profiles');
  });

  await t.test('should securely merge session cache datasets on set', async () => {
    await syncCache.set(testDid, { status: 'enriching', error: 'Temporary connection timeout' });
    const entry = await syncCache.get(testDid);
    assert.strictEqual(entry.status, 'enriching');
    assert.strictEqual(entry.error, 'Temporary connection timeout');
    // Ensure nested progress was preserved
    assert.strictEqual(entry.progress.processed, 10);
  });

  await t.test(
    'should correctly preserve and cache custom following attributes like followingUri and criteria',
    async () => {
      const customFollowings = [
        {
          did: 'did:plc:targetUser',
          handle: 'target.bsky.social',
          displayName: 'Target User',
          followingUri: 'at://did:plc:testuser123/app.bsky.graph.follow/12345',
          criteria: {
            isInactive: true,
            isFollowingUser: false,
          },
        },
      ];

      await syncCache.set(testDid, {
        status: 'completed',
        followings: customFollowings,
      });

      const entry = await syncCache.get(testDid);
      assert.strictEqual(entry.status, 'completed');
      assert.strictEqual(entry.followings.length, 1);
      assert.strictEqual(
        entry.followings[0].followingUri,
        'at://did:plc:testuser123/app.bsky.graph.follow/12345',
      );
      assert.strictEqual(entry.followings[0].criteria.isInactive, true);
      assert.strictEqual(entry.followings[0].criteria.isFollowingUser, false);
    },
  );

  await t.test('should wipe records from memory on clear', async () => {
    await syncCache.clear(testDid);
    const entry = await syncCache.get(testDid);
    // Cleared records should return to fresh idle state
    assert.strictEqual(entry.status, 'idle');
    assert.strictEqual(entry.progress.processed, 0);
  });
});
