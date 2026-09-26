// OAuth client setup only. Kept separate from atproto.js so the sign-in page doesn't
// have to download @atproto/api (the bulk of the bundle) until a session exists.
import { BrowserOAuthClient, atprotoLoopbackClientMetadata } from '@atproto/oauth-client-browser';
import { OAUTH_SCOPE, buildClientMetadata } from './scopes.js';

let oauthClient = null;

/** Loopback hosts allowed for local development OAuth clients (RFC 8252). */
export function isLoopbackHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';
}

/**
 * Initializes and returns the `@atproto/oauth-client-browser` instance dynamically
 * using the current window's origin (supporting both development loopback and production hosting).
 */
export function initOAuthClient() {
  if (oauthClient) return oauthClient;

  const origin = window.location.origin;
  const redirectUri = origin + '/';

  if (isLoopbackHost(window.location.hostname)) {
    // Local development uses the special loopback client ID format with query parameters.
    const clientId = `http://localhost?redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      clientMetadata: atprotoLoopbackClientMetadata(clientId),
    });
  } else {
    oauthClient = new BrowserOAuthClient({
      handleResolver: 'https://bsky.social',
      // Must match the client-metadata.json generated for this origin at build time.
      clientMetadata: buildClientMetadata(origin),
    });
  }

  return oauthClient;
}
