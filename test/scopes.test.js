import test from 'node:test';
import assert from 'node:assert';
import {
  OAUTH_SCOPE,
  REQUIRED_SCOPES,
  buildClientMetadata,
  describeScopes,
  getMissingScopes,
  hasLegacyBroadScopes,
  parseScope,
} from '../src/scopes.js';

test('OAuth scopes', async (t) => {
  await t.test('requests no broad legacy scopes', () => {
    assert.doesNotMatch(OAUTH_SCOPE, /transition:/);
    assert.match(OAUTH_SCOPE, /repo:app\.bsky\.graph\.follow\?action=create&action=delete/);
  });

  await t.test('an older broad grant is prompted to switch to the narrower set', () => {
    const olderGrant = 'atproto transition:generic transition:chat.bsky repo:app.bsky.graph.follow';
    const missing = getMissingScopes(olderGrant);
    // Everything except sign-in and the (unrestricted, so covering) follow permission.
    assert.deepStrictEqual(
      missing.map(({ scope }) => scope).filter((s) => s.startsWith('repo') || s === 'atproto'),
      [],
    );
    assert.ok(missing.some(({ scope }) => scope.startsWith('rpc:chat.bsky.convo.listConvos')));
    assert.ok(hasLegacyBroadScopes(olderGrant));
    assert.deepStrictEqual(describeScopes(missing), [
      'read your follows, profiles and notifications',
      'include direct messages in interaction scoring',
    ]);
  });

  await t.test('is empty for a full grant, in any order/spacing', () => {
    const shuffled = [...REQUIRED_SCOPES]
      .reverse()
      .map(({ scope }) => scope)
      .join('   ');
    assert.deepStrictEqual(getMissingScopes(shuffled), []);
    assert.deepStrictEqual(getMissingScopes(OAUTH_SCOPE), []);
    assert.strictEqual(hasLegacyBroadScopes(OAUTH_SCOPE), false);
  });

  await t.test('accepts equivalent spellings the server may return', () => {
    const aud = 'did:web:api.bsky.app#bsky_appview';
    const granted = [
      'atproto',
      // Query-only form with several methods and an unencoded fragment.
      `rpc?lxm=app.bsky.graph.getFollows&lxm=app.bsky.actor.getProfile&lxm=app.bsky.actor.getProfiles&aud=${aud}`,
      // Wildcard method for the AppView audience.
      `rpc:*?aud=${encodeURIComponent(aud)}`,
      'rpc:chat.bsky.convo.listConvos?aud=did:web:api.bsky.chat%23bsky_chat',
      'repo?collection=app.bsky.graph.follow&action=delete&action=create',
    ].join(' ');
    assert.deepStrictEqual(getMissingScopes(granted), []);
  });

  await t.test('narrower grants are still reported as missing', () => {
    const granted = OAUTH_SCOPE.replace(
      'repo:app.bsky.graph.follow?action=create&action=delete',
      'repo:app.bsky.graph.follow?action=delete',
    ).replace(
      /rpc:chat\.bsky\.convo\.listConvos\?aud=\S+/,
      'rpc:chat.bsky.convo.listConvos?aud=did:web:evil.example%23bsky_chat',
    );
    assert.deepStrictEqual(
      getMissingScopes(granted).map(({ purpose }) => purpose),
      ['include direct messages in interaction scoring', 'unfollow and re-follow accounts'],
    );
  });

  await t.test('treats an empty grant as missing everything', () => {
    assert.strictEqual(getMissingScopes('').length, REQUIRED_SCOPES.length);
    assert.strictEqual(getMissingScopes(undefined).length, REQUIRED_SCOPES.length);
  });

  await t.test('parses positional and query parameters', () => {
    const parsed = parseScope('repo:app.bsky.graph.follow?action=create&action=delete');
    assert.strictEqual(parsed.resource, 'repo');
    assert.deepStrictEqual([...parsed.params.get('collection')], ['app.bsky.graph.follow']);
    assert.deepStrictEqual([...parsed.params.get('action')], ['create', 'delete']);
  });

  await t.test('client metadata is derived from the origin and scopes', () => {
    const metadata = buildClientMetadata('https://example.test');
    assert.deepStrictEqual(metadata, {
      client_id: 'https://example.test/client-metadata.json',
      client_name: 'ByeSky',
      client_uri: 'https://example.test',
      redirect_uris: ['https://example.test/'],
      scope: OAUTH_SCOPE,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      dpop_bound_access_tokens: true,
    });
  });
});
