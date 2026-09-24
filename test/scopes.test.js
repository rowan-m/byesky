import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { OAUTH_SCOPE, REQUIRED_SCOPES, getMissingScopes } from '../src/scopes.js';

test('OAuth scopes', async (t) => {
  await t.test('getMissingScopes reports scopes absent from an older grant', () => {
    const olderGrant = 'atproto transition:generic repo:app.bsky.graph.follow';
    const missing = getMissingScopes(olderGrant);
    assert.deepStrictEqual(
      missing.map(({ scope }) => scope),
      ['transition:chat.bsky'],
    );
    assert.match(missing[0].purpose, /direct messages/);
  });

  await t.test('getMissingScopes is empty for a full grant, in any order/spacing', () => {
    const shuffled = [...REQUIRED_SCOPES]
      .reverse()
      .map(({ scope }) => scope)
      .join('   ');
    assert.deepStrictEqual(getMissingScopes(shuffled), []);
    assert.deepStrictEqual(getMissingScopes(OAUTH_SCOPE), []);
  });

  await t.test('getMissingScopes treats an empty grant as missing everything', () => {
    assert.strictEqual(getMissingScopes('').length, REQUIRED_SCOPES.length);
    assert.strictEqual(getMissingScopes(undefined).length, REQUIRED_SCOPES.length);
  });

  await t.test('production client metadata requests the same scopes', () => {
    const metadata = JSON.parse(readFileSync('public/client-metadata.json', 'utf8'));
    assert.strictEqual(metadata.scope, OAUTH_SCOPE);
  });
});
