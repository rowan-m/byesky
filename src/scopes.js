// OAuth scopes the app needs. Kept dependency-free so it can be unit tested and shared by
// the OAuth client setup (auth.js) and the granted-scope check (main.js).

/** Scopes requested at sign-in, with what each one is used for. */
export const REQUIRED_SCOPES = [
  { scope: 'atproto', purpose: 'sign in' },
  { scope: 'transition:generic', purpose: 'read your follows, feed and notifications' },
  { scope: 'transition:chat.bsky', purpose: 'include direct messages in interaction scoring' },
  { scope: 'repo:app.bsky.graph.follow', purpose: 'unfollow and re-follow accounts' },
];

export const OAUTH_SCOPE = REQUIRED_SCOPES.map(({ scope }) => scope).join(' ');

/**
 * Returns the required scopes missing from a granted scope string (space-separated, as
 * returned in the OAuth token response). Sessions authorised before a scope was added to
 * the app won't include it until the user signs in again.
 */
export function getMissingScopes(grantedScope) {
  const granted = new Set((grantedScope || '').split(/\s+/).filter(Boolean));
  return REQUIRED_SCOPES.filter(({ scope }) => !granted.has(scope));
}
