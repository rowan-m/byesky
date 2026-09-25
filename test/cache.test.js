import test from 'node:test';
import assert from 'node:assert';
import { CACHE_SCHEMA_VERSION, syncCache, UserSyncCache } from '../src/cache.js';

function createFakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

function cloneRecord(val) {
  return JSON.parse(JSON.stringify(val));
}

function createFakeIndexedDB({ failOpenOnce = false } = {}) {
  const records = new Map();
  let putCount = 0;
  let deleteCount = 0;
  let openAttempts = 0;
  const stores = new Set();

  const db = {
    objectStoreNames: {
      contains: (name) => stores.has(name),
    },
    createObjectStore: (name) => {
      stores.add(name);
    },
    transaction: () => ({
      objectStore: () => ({
        get: (key) => {
          const req = { result: undefined, onsuccess: null, onerror: null };
          Promise.resolve().then(() => {
            req.result = records.has(key) ? cloneRecord(records.get(key)) : undefined;
            req.onsuccess?.();
          });
          return req;
        },
        put: (val, key) => {
          const req = { onsuccess: null, onerror: null };
          Promise.resolve().then(() => {
            putCount++;
            records.set(key, cloneRecord(val));
            req.onsuccess?.();
          });
          return req;
        },
        delete: (key) => {
          const req = { onsuccess: null, onerror: null };
          Promise.resolve().then(() => {
            deleteCount++;
            records.delete(key);
            req.onsuccess?.();
          });
          return req;
        },
      }),
    }),
  };

  return {
    records,
    get putCount() {
      return putCount;
    },
    get deleteCount() {
      return deleteCount;
    },
    get openAttempts() {
      return openAttempts;
    },
    open: () => {
      openAttempts++;
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null };
      Promise.resolve().then(() => {
        if (failOpenOnce && openAttempts === 1) {
          req.onerror?.({ target: { error: new Error('IDB open failed') } });
          return;
        }
        req.onupgradeneeded?.({ target: { result: db } });
        req.onsuccess?.({ target: { result: db } });
      });
      return req;
    },
  };
}

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

  await t.test('should preserve lockedDids across cache clears and resyncs', async () => {
    await syncCache.setLockedDids(testDid, [
      'did:plc:friend1',
      'did:plc:friend2',
      'did:plc:friend1',
    ]);
    const lockedBefore = await syncCache.getLockedDids(testDid);
    assert.deepStrictEqual(lockedBefore, ['did:plc:friend1', 'did:plc:friend2']);

    await syncCache.clear(testDid);
    const entry = await syncCache.get(testDid);
    // Cleared records should return to fresh idle state while preserving lockedDids
    assert.strictEqual(entry.status, 'idle');
    assert.strictEqual(entry.progress.processed, 0);
    assert.deepStrictEqual(entry.lockedDids, ['did:plc:friend1', 'did:plc:friend2']);
  });
});

test('UserSyncCache IndexedDB persistence, coalescing, migration, and reload', async (t) => {
  await t.test('coalesces rapid writes and flushes on demand', async () => {
    const idb = createFakeIndexedDB();
    const storage = createFakeStorage();
    const cache = new UserSyncCache({
      indexedDB: idb,
      localStorage: storage,
      persistIntervalMs: 5000,
    });
    const did = 'did:plc:coalesce';

    // First write has no prior lastWriteAt so delay is 0; wait for it to settle.
    await cache.set(did, { status: 'fetching' });
    await cache.flush(did);
    const initialPuts = idb.putCount;
    assert.strictEqual(initialPuts, 1);

    // Rapid subsequent updates within persistIntervalMs should schedule only one pending write.
    await cache.updateProgress(did, 1, 10, 'Step 1');
    await cache.updateProgress(did, 2, 10, 'Step 2');
    await cache.updateProgress(did, 3, 10, 'Step 3');
    assert.strictEqual(idb.putCount, 1);
    assert.strictEqual(cache.pendingWrites.has(did), true);

    await cache.flush(did);
    assert.strictEqual(idb.putCount, 2);
    assert.strictEqual(cache.pendingWrites.has(did), false);
    assert.strictEqual(idb.records.get(did).progress.processed, 3);
  });

  await t.test('migrates older entries and supports setLocal + reload across tabs', async () => {
    const idb = createFakeIndexedDB();
    const storage = createFakeStorage();
    const did = 'did:plc:migrate';

    // Seed a v1 entry (no schemaVersion) directly in IndexedDB.
    idb.records.set(did, {
      status: 'enriching',
      progress: { processed: 5, total: 20, currentStage: 'From other tab' },
      followings: [],
    });

    const cache = new UserSyncCache({
      indexedDB: idb,
      localStorage: storage,
      persistIntervalMs: 5000,
    });

    const loaded = await cache.get(did);
    assert.strictEqual(loaded.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.strictEqual(loaded.progress.processed, 5);

    // setLocal updates memory only and never schedules an IndexedDB write.
    cache.setLocal(did, { runningElsewhere: true });
    assert.strictEqual((await cache.get(did)).runningElsewhere, true);
    assert.strictEqual(cache.pendingWrites.has(did), false);

    // Simulate another tab writing newer progress to IndexedDB and reload() picking it up.
    idb.records.set(did, {
      status: 'completed',
      progress: { processed: 20, total: 20, currentStage: 'Done' },
      followings: [{ did: 'did:plc:f1', handle: 'f1.bsky.social' }],
    });
    const reloaded = await cache.reload(did);
    assert.strictEqual(reloaded.status, 'completed');
    assert.strictEqual(reloaded.schemaVersion, CACHE_SCHEMA_VERSION);
    assert.strictEqual(reloaded.followings.length, 1);
  });

  await t.test(
    'clear removes IndexedDB entry and preserves lockedDids in localStorage',
    async () => {
      const idb = createFakeIndexedDB();
      const storage = createFakeStorage();
      const cache = new UserSyncCache({
        indexedDB: idb,
        localStorage: storage,
        persistIntervalMs: 5000,
      });
      const did = 'did:plc:clear';

      await cache.setLockedDids(did, ['did:plc:keep']);
      await cache.set(did, { status: 'completed', followings: [{ did: 'did:plc:keep' }] });
      await cache.flush(did);
      assert.strictEqual(idb.records.has(did), true);

      await cache.clear(did);
      assert.strictEqual(idb.records.has(did), false);
      assert.deepStrictEqual(await cache.getLockedDids(did), ['did:plc:keep']);
      assert.deepStrictEqual(JSON.parse(storage.getItem(`byesky_locked_${did}`)), ['did:plc:keep']);
    },
  );

  await t.test('retries opening IndexedDB after a transient open error', async () => {
    const idb = createFakeIndexedDB({ failOpenOnce: true });
    const cache = new UserSyncCache({ indexedDB: idb, persistIntervalMs: 0 });
    const did = 'did:plc:retry-open';

    // First call fails to open IDB and falls back to memory; dbPromise is cleared.
    const fallback = await cache.get(did);
    assert.strictEqual(fallback.status, 'idle');
    assert.strictEqual(idb.openAttempts, 1);

    // Clear in-memory entry so the next get() tries _getDB() again and succeeds.
    cache.store.delete(did);
    idb.records.set(did, {
      status: 'completed',
      progress: { total: 1, processed: 1 },
      followings: [],
    });
    const recovered = await cache.get(did);
    assert.strictEqual(recovered.status, 'completed');
    assert.strictEqual(idb.openAttempts, 2);
  });
});
