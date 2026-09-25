import { defaultFilters, defaultWeights } from '../criteria.js';
import { prepareFollowing } from '../scoring.js';

// Application State
export const state = {
  user: null, // { loggedIn: false } or { loggedIn: true, did, handle }
  session: null, // Active OAuthSession object
  agent: null, // ATProto Agent instance
  sync: {
    status: 'idle',
    error: null,
    progress: { total: 0, processed: 0, currentStage: 'Not started' },
    totalCount: 0,
  },
  followings: [], // Raw followings from backend
  followingsByDid: new Map(), // O(1) lookup by DID
  selectedDids: new Set(), // DIDs marked for unfollowing
  lockedDids: new Set(), // DIDs protected from Select All and unfollowing
  pagination: {
    currentPage: 1,
    pageSize: 100,
  },
  sorting: {
    col: 'score',
    order: 'desc', // High score (strongest unfollow reason) shown first
  },
  searchQuery: '',
  weights: defaultWeights(),
  filters: defaultFilters(),
  params: {
    inactiveDays: 180,
    lowFollowersThreshold: 50,
    noisyPostsThreshold: 20,
    massFollowerThreshold: 3500,
  },
  pendingUnfollowDids: [], // Holds DIDs during confirmation modal
  missingScopes: [], // Required OAuth scopes this session wasn't granted (see scopes.js)
  hasLegacyScopes: false, // Session still holds broad scopes from before granular permissions
};

export function setFollowings(list = []) {
  state.followings = list.map(prepareFollowing);
  state.followingsByDid = new Map(state.followings.map((item) => [item.did, item]));
}

export function getFollowing(did) {
  return state.followingsByDid.get(did);
}

// @atproto/api is ~80% of the bundle and only needed once signed in, so it's loaded on demand.
// Exported as a live binding: it stays null until loadAtprotoApi() has resolved.
export let atprotoApi = null;
export async function loadAtprotoApi() {
  atprotoApi ??= await import('../atproto.js');
  return atprotoApi;
}

// Hint (not a credential) that a session probably exists, so the API chunk can be
// fetched in parallel with OAuth session restore instead of after it.
const SESSION_HINT_KEY = 'byesky:hasSession';
export function setSessionHint(hasSession) {
  try {
    if (hasSession) localStorage.setItem(SESSION_HINT_KEY, '1');
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // Storage unavailable; we just lose the preload optimisation.
  }
}
export function isLikelySignedIn() {
  const isOAuthCallback = /[?#&](code|state)=/.test(window.location.search + window.location.hash);
  try {
    return isOAuthCallback || localStorage.getItem(SESSION_HINT_KEY) === '1';
  } catch {
    return isOAuthCallback;
  }
}
