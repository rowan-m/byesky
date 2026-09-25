import test from 'node:test';
import assert from 'node:assert';
import { applyActorError, quotedAuthorDid } from '../src/atproto.js';

const fresh = () => ({ criteria: { unknown: [] } });

test('applyActorError uses XRPC error names', async (t) => {
  await t.test('blocked-by-them sets isBlocked, not isBlocking', () => {
    const f = fresh();
    applyActorError(f, { status: 400, error: 'BlockedByActor', message: 'blocked' });
    assert.strictEqual(f.criteria.isBlocked, true);
    assert.strictEqual(f.criteria.isBlocking, undefined);
  });

  await t.test('you blocking them sets isBlocking', () => {
    const f = fresh();
    applyActorError(f, { status: 400, error: 'BlockedActor' });
    assert.strictEqual(f.criteria.isBlocking, true);
  });

  await t.test('takedown and deactivation', () => {
    const banned = fresh();
    applyActorError(banned, { status: 400, error: 'AccountTakedown' });
    assert.strictEqual(banned.criteria.isBanned, true);

    const gone = fresh();
    applyActorError(gone, { status: 400, error: 'AccountDeactivated' });
    assert.strictEqual(gone.criteria.isDeleted, true);
  });

  await t.test('network and server errors mark activity unknown', () => {
    for (const err of [
      new TypeError('Failed to fetch'),
      { status: 502, error: 'UpstreamFailure' },
    ]) {
      const f = fresh();
      applyActorError(f, err);
      assert.deepStrictEqual(f.criteria.unknown, ['activity']);
      assert.strictEqual(f.criteria.isBlocking, undefined);
      assert.strictEqual(f.criteria.isBanned, undefined);
    }
  });

  await t.test('message text mentioning "block" is not treated as a block', () => {
    const f = fresh();
    applyActorError(f, { status: 500, message: 'blockstore unavailable' });
    assert.strictEqual(f.criteria.isBlocking, undefined);
    assert.deepStrictEqual(f.criteria.unknown, ['activity']);
  });
});

test('quotedAuthorDid reads plain and with-media quote embeds', () => {
  assert.strictEqual(
    quotedAuthorDid({
      $type: 'app.bsky.embed.record#view',
      record: { author: { did: 'did:plc:a' } },
    }),
    'did:plc:a',
  );
  assert.strictEqual(
    quotedAuthorDid({
      $type: 'app.bsky.embed.recordWithMedia#view',
      record: { record: { author: { did: 'did:plc:b' } } },
    }),
    'did:plc:b',
  );
  assert.strictEqual(quotedAuthorDid({ $type: 'app.bsky.embed.images#view' }), null);
  assert.strictEqual(quotedAuthorDid(undefined), null);
});
