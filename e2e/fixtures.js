import { OAUTH_SCOPE } from '../src/scopes.js';

// Test doubles for the network-facing modules, served in place of the real ones by the
// Vite dev server via Playwright request interception.

const USER_DID = 'did:plc:e2euser';
const DAY = 24 * 60 * 60 * 1000;

function makeFollowings(count = 40) {
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => ({
    did: `did:plc:acct${i}`,
    handle: `account-${i}.bsky.social`,
    displayName: `Account ${i}`,
    avatar: '',
    followingUri: `at://${USER_DID}/app.bsky.graph.follow/${i}`,
    criteria: {
      isDeleted: false,
      isBanned: false,
      isInactive: i % 5 === 0,
      isBlocking: false,
      isBlocked: false,
      isFollowingUser: i % 2 === 0,
      hasLikedUser: false,
      hasRepostedUser: false,
      hasRepliedToUser: false,
      hasMessagedUser: false,
      userInteracted: i % 3 === 0,
      userContactedThem: false,
      isMuted: false,
      isMassFollower: i % 7 === 0,
      isSpammyRatio: false,
      isFlagged: false,
      isOutlier: false,
      isNoisy: i % 4 === 0,
      postsCount7Days: i % 30,
      mutualsCount: i % 12,
      lastPostDate: i % 9 === 0 ? null : new Date(now - i * 20 * DAY).toISOString(),
      lastLikeDate: null,
      lastInteraction: null,
      followersCount: i * 137,
      followsCount: i * 211,
      postsCount: i % 9 === 0 ? 0 : i * 13,
    },
    score: 0,
  }));
}

const fakeAuthModule = (followings, grantedScope, syncState) => `
import { syncCache } from '/src/cache.js';
const USER_DID = ${JSON.stringify(USER_DID)};
const followings = ${JSON.stringify(followings)};
const grantedScope = ${JSON.stringify(grantedScope)};
const syncState = ${JSON.stringify(syncState || null)};
export function initOAuthClient() {
  return {
    async init() {
      await syncCache.set(USER_DID, {
        status: 'completed',
        error: null,
        progress: { total: followings.length, processed: followings.length, currentStage: 'Done' },
        followings,
        lockedDids: [],
        ...syncState,
      });
      return {
        session: {
          did: USER_DID,
          signOut: async () => {},
          getTokenInfo: async () => ({ scope: grantedScope }),
        },
      };
    },
    async signIn(handle) {
      (window.__signInCalls ||= []).push(handle);
    },
  };
}
`;

const fakeAtprotoModule = `
const app = { bsky: { actor: {
  getProfile: async () => ({ data: { handle: 'e2e-user.bsky.social' } }),
} } };
export function createAgent() {
  return { app, api: { app } };
}
export function createViewerAgent() {
  return { app, api: { app } };
}
export function startBackgroundSync() { (window.__syncStarts ||= 0); window.__syncStarts++; return Promise.resolve(); }
export function cancelSync() { window.__syncCancels = (window.__syncCancels || 0) + 1; }
export async function batchUnfollow(agent, userDid, dids) {
  if (window.__batchUnfollow) return window.__batchUnfollow(dids);
  return { success: dids, failed: [] };
}
export async function followUser(agent, userDid, targetDid) {
  if (window.__followUser) return window.__followUser(targetDid);
  return { did: targetDid, followingUri: 'at://' + userDid + '/app.bsky.graph.follow/restored' };
}
export async function fetchAccountPreview(agent, userDid, targetDid) {
  const n = targetDid.replace('did:plc:acct', '');
  return {
    description: 'Bio for Account ' + n,
    preview: { mutuals: [], lastPost: null },
    mutualsCount: 0,
    hasMoreMutuals: false,
  };
}
`;

/** Serves fake auth/API modules so the dashboard renders with fixture data. */
export async function mockSignedInApp(
  page,
  { count = 40, grantedScope = OAUTH_SCOPE, syncState = null, patches = {} } = {},
) {
  // patches: { [index]: { criteria: {...} } } merged into individual fixture accounts.
  const followings = makeFollowings(count).map((f, i) =>
    patches[i] ? { ...f, criteria: { ...f.criteria, ...patches[i].criteria } } : f,
  );
  await page.route(
    (url) => url.pathname === '/src/auth.js',
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: fakeAuthModule(followings, grantedScope, syncState),
      }),
  );
  await page.route(
    (url) => url.pathname === '/src/atproto.js',
    (route) => route.fulfill({ contentType: 'text/javascript', body: fakeAtprotoModule }),
  );
  // Never hit real Bluesky endpoints (avatars etc.) from tests.
  await page.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => route.abort(),
  );
}
