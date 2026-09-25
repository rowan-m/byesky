// OAuth scopes the app needs. Kept dependency-free so it can be unit tested and shared by
// the OAuth client setup (auth.js), the generated client metadata and the granted-scope
// check (main.js).
//
// ByeSky asks for granular permissions rather than `transition:generic`, which would let it
// post, delete and edit the profile on the user's behalf. It only needs to read a handful
// of AppView endpoints (through the user's PDS), list DM conversations and create/delete
// follow records.

export const APPVIEW_SERVICE = 'did:web:api.bsky.app#bsky_appview';
export const CHAT_SERVICE = 'did:web:api.bsky.chat#bsky_chat';

// Scope strings are space-separated, and `#` would start a URL fragment, so the service
// fragment separator is the one character that has to be percent-encoded (as in the spec).
const audParam = (service) => service.replace('#', '%23');

const READ_PURPOSE = 'read your follows, profiles and notifications';

const appviewRpc = (method) => ({
  scope: `rpc:${method}?aud=${audParam(APPVIEW_SERVICE)}`,
  purpose: READ_PURPOSE,
});

/** Scopes requested at sign-in, with what each one is used for. */
export const REQUIRED_SCOPES = [
  { scope: 'atproto', purpose: 'sign in' },
  appviewRpc('app.bsky.graph.getFollows'),
  appviewRpc('app.bsky.actor.getProfile'),
  appviewRpc('app.bsky.actor.getProfiles'),
  appviewRpc('app.bsky.graph.getKnownFollowers'),
  appviewRpc('app.bsky.notification.listNotifications'),
  appviewRpc('app.bsky.feed.getAuthorFeed'),
  {
    scope: `rpc:chat.bsky.convo.listConvos?aud=${audParam(CHAT_SERVICE)}`,
    purpose: 'include direct messages in interaction scoring',
  },
  {
    scope: 'repo:app.bsky.graph.follow?action=create&action=delete',
    purpose: 'unfollow and re-follow accounts',
  },
];

export const OAUTH_SCOPE = REQUIRED_SCOPES.map(({ scope }) => scope).join(' ');

/** Broad legacy scopes that ByeSky no longer needs and prompts users to drop. */
const LEGACY_BROAD_SCOPES = new Set(['transition:generic', 'transition:chat.bsky']);

// Positional parameter name for each permission resource, per the atproto permission spec
// (e.g. `repo:app.bsky.graph.follow` is `repo?collection=app.bsky.graph.follow`).
const POSITIONAL_PARAM = { repo: 'collection', rpc: 'lxm', blob: 'accept', include: 'nsid' };

/**
 * Parses a scope string into `{ resource, params }`, where params maps each parameter name
 * to a Set of values. Handles both the positional (`rpc:method?aud=x`) and query-only
 * (`rpc?lxm=method&aud=x`) forms, and percent-encoding differences.
 */
export function parseScope(scope) {
  const qIndex = scope.indexOf('?');
  const head = qIndex === -1 ? scope : scope.slice(0, qIndex);
  const query = qIndex === -1 ? '' : scope.slice(qIndex + 1);
  const colon = head.indexOf(':');
  const resource = colon === -1 ? head : head.slice(0, colon);
  const positional = colon === -1 ? undefined : decodeURIComponent(head.slice(colon + 1));

  const params = new Map();
  const add = (key, value) => {
    if (!params.has(key)) params.set(key, new Set());
    params.get(key).add(value);
  };
  if (positional !== undefined) add(POSITIONAL_PARAM[resource] || '_', positional);
  for (const [key, value] of new URLSearchParams(query)) add(key, value);
  return { resource, params };
}

/**
 * True if `granted` grants everything `required` asks for: same resource and, for each
 * parameter the requirement names, the grant allows those values (or all of them, via `*`
 * or by not restricting that parameter at all, e.g. a repo scope without `action`).
 */
function covers(granted, required) {
  if (granted.resource !== required.resource) return false;
  for (const [key, values] of required.params) {
    const allowed = granted.params.get(key);
    if (!allowed || allowed.has('*')) continue;
    for (const value of values) if (!allowed.has(value)) return false;
  }
  return true;
}

/**
 * Returns the required scopes missing from a granted scope string (space-separated, as
 * returned in the OAuth token response). Sessions authorised before a scope was added to
 * the app won't include it until the user signs in again. Legacy broad scopes such as
 * `transition:generic` deliberately don't count, so older sessions are prompted once to
 * switch to the narrower set.
 */
export function getMissingScopes(grantedScope) {
  const granted = (grantedScope || '')
    .split(/\s+/)
    .filter((s) => s && !LEGACY_BROAD_SCOPES.has(s))
    .map(parseScope);
  return REQUIRED_SCOPES.filter(({ scope }) => {
    const required = parseScope(scope);
    return !granted.some((g) => covers(g, required));
  });
}

/** True if the grant still includes broad legacy scopes ByeSky no longer asks for. */
export function hasLegacyBroadScopes(grantedScope) {
  return (grantedScope || '').split(/\s+/).some((s) => LEGACY_BROAD_SCOPES.has(s));
}

/** Distinct human-readable purposes for a list of scopes, in order. */
export function describeScopes(scopes) {
  return [...new Set(scopes.map(({ purpose }) => purpose))];
}

/**
 * OAuth client metadata for a deployment origin. Used at runtime by the OAuth client and at
 * build time to generate the served `client-metadata.json`, so the two can't drift apart.
 */
export function buildClientMetadata(origin) {
  return {
    client_id: `${origin}/client-metadata.json`,
    client_name: 'ByeSky',
    client_uri: origin,
    redirect_uris: [`${origin}/`],
    scope: OAUTH_SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}
