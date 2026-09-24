// OAuth client setup only. Kept separate from atproto.js so the sign-in page doesn't
// have to download @atproto/api (the bulk of the bundle) until a session exists.
import { BrowserOAuthClient, atprotoLoopbackClientMetadata } from '@atproto/oauth-client-browser';
import { OAUTH_SCOPE } from './scopes.js';

let oauthClient = null;

/**
 * Initializes and returns the `@atproto/oauth-client-browser` instance dynamically
 * using the current window's origin (supporting both development loopback and production hosting).
 */
export function initOAuthClient() {
  if (oauthClient) return oauthClient;

  const origin = window.location.origin;
  const redirectUri = origin + '/';

  // For localhost / local loopback, use the special Client ID format with query parameters
  const isLocal = origin.includes('localhost') || origin.includes('127.0.0.1');

  if (isLocal) {
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: atprotoLoopbackClientMetadata(clientId),
    });
  } else {
    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: {
        client_id: `${origin}/client-metadata.json`,
        client_name: 'ByeSky',
        client_uri: origin,
        redirect_uris: [redirectUri],
        scope: OAUTH_SCOPE,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        application_type: 'web',
        dpop_bound_access_tokens: true,
      },
    });
  }

  return oauthClient;
}
