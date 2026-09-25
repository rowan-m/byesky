import { initOAuthClient } from '../auth.js';
import { syncCache } from '../cache.js';
import { describeScopes, getMissingScopes, hasLegacyBroadScopes } from '../scopes.js';
import {
  appLoadingSection,
  authSection,
  dashboardSection,
  loginError,
  loginForm,
  loginHandle,
  logoutBtn,
  syncSection,
  userHandleSpan,
  userProfile,
} from './dom.js';
import {
  atprotoApi,
  isLikelySignedIn,
  loadAtprotoApi,
  setFollowings,
  setSessionHint,
  state,
} from './state.js';
import { checkSyncStatus, triggerSync } from './sync-ui.js';

// Sessions authorised before the app added a scope keep their original grant until the
// user signs in again, so check what was granted and prompt if anything is missing.
const RESYNC_AFTER_REAUTH_KEY = 'byesky:resyncAfterReauth';

export function setupSessionListeners() {
  loginForm.addEventListener('submit', handleLogin);
  logoutBtn.addEventListener('click', handleLogout);
  document.getElementById('reauth-btn')?.addEventListener('click', handleReauth);
}

export async function checkSession() {
  try {
    if (isLikelySignedIn()) loadAtprotoApi().catch(() => {}); // warm up in parallel
    const oauthClient = initOAuthClient();
    const result = await oauthClient.init();

    if (result && result.session) {
      const api = await loadAtprotoApi();
      setSessionHint(true);
      state.session = result.session;
      state.agent = api.createAgent(result.session);

      state.user = {
        loggedIn: true,
        did: result.session.did,
        handle: await resolveOwnHandle(api, result.session.did),
      };

      showUserSession(state.user.handle);
      const missingScopes = await checkGrantedScopes(result.session);
      // Returning from "Sign in again": resync so the newly granted data is included.
      if (consumeResyncAfterReauth() && missingScopes.length === 0) {
        await triggerSync();
      } else {
        await checkSyncStatus();
      }
    } else {
      setSessionHint(false);
      state.user = null;
      showAuthSection();
    }
  } catch (err) {
    console.error('Session check failed:', err);
    state.user = null;
    showAuthSection();
  }
}

/**
 * Looks up the signed-in user's handle for display. A valid session must not be treated as
 * signed out just because the lookup failed (e.g. while Bluesky is rate limiting), so fall
 * back to the authenticated route and finally to the DID.
 */
async function resolveOwnHandle(api, did) {
  try {
    const publicAgent = api.createAgent({ service: 'https://api.bsky.app' });
    return (await publicAgent.app.bsky.actor.getProfile({ actor: did })).data.handle;
  } catch (err) {
    console.warn('Public profile lookup failed, trying via the PDS:', err);
  }
  try {
    const viewer = api.createViewerAgent(state.agent);
    return (await viewer.app.bsky.actor.getProfile({ actor: did })).data.handle;
  } catch (err) {
    console.warn('Could not look up own handle; showing DID instead:', err);
    return did;
  }
}

async function checkGrantedScopes(session) {
  let missing = [];
  let legacy = false;
  try {
    const { scope } = await session.getTokenInfo(false);
    missing = getMissingScopes(scope);
    legacy = hasLegacyBroadScopes(scope);
  } catch (err) {
    console.warn('Could not read granted OAuth scopes:', err);
  }
  state.missingScopes = missing;
  state.hasLegacyScopes = legacy;
  renderReauthBanner();
  return missing;
}

function renderReauthBanner(errorMessage = '') {
  const banner = document.getElementById('reauth-banner');
  const detail = document.getElementById('reauth-banner-detail');
  if (!banner || !detail) return;

  const missing = state.user ? state.missingScopes : [];
  banner.classList.toggle('hidden', missing.length === 0);
  if (missing.length === 0) return;

  const purposes = describeScopes(missing).join(' and ');
  const title = document.getElementById('reauth-banner-title');
  if (title) {
    title.textContent = state.hasLegacyScopes
      ? 'ByeSky has narrowed its permissions.'
      : 'ByeSky needs an extra permission.';
  }
  const message = state.hasLegacyScopes
    ? 'It now asks only for what it needs instead of broad access to your account. Sign in again to switch; until then some results may be incomplete.'
    : `Sign in again to allow it to ${purposes}. Syncing still works, but results will be incomplete until you do.`;
  detail.textContent = errorMessage || message;
}

function consumeResyncAfterReauth() {
  try {
    const pending = sessionStorage.getItem(RESYNC_AFTER_REAUTH_KEY) === '1';
    sessionStorage.removeItem(RESYNC_AFTER_REAUTH_KEY);
    return pending;
  } catch {
    return false;
  }
}

async function handleReauth() {
  if (!state.user) return;
  try {
    sessionStorage.setItem(RESYNC_AFTER_REAUTH_KEY, '1');
  } catch {
    // Without storage we just skip the automatic resync after returning.
  }
  try {
    // Redirects to the user's PDS, which asks them to approve the full, current scope set.
    await initOAuthClient().signIn(state.user.handle);
  } catch (err) {
    renderReauthBanner(`Couldn't start sign-in: ${err.message || err}. Please try again.`);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  loginError.classList.add('hidden');
  loginError.textContent = '';

  const handle = loginHandle.value.trim();
  if (!handle) return;

  try {
    const oauthClient = initOAuthClient();
    // Redirects browser window to user's PDS auth page
    await oauthClient.signIn(handle);
  } catch (err) {
    loginError.textContent = err.message || 'OAuth initiation failed.';
    loginError.classList.remove('hidden');
  }
}

async function handleLogout() {
  if (state.user) atprotoApi?.cancelSync?.(state.user.did);
  if (state.user && state.session) {
    try {
      await state.session.signOut();
    } catch (err) {
      console.warn('Signout error:', err);
    }
    await syncCache.clear(state.user.did);
  }

  setSessionHint(false);
  state.user = null;
  state.session = null;
  state.agent = null;
  state.missingScopes = [];
  renderReauthBanner();
  setFollowings([]);
  state.selectedDids.clear();
  state.lockedDids.clear();
  showAuthSection();
}

export function hideLoading() {
  if (appLoadingSection) {
    appLoadingSection.classList.add('hidden');
  }
}

export function showAuthSection() {
  hideLoading();
  authSection.classList.remove('hidden');
  syncSection.classList.add('hidden');
  dashboardSection.classList.add('hidden');
  userProfile.classList.add('hidden');
}

export function showUserSession(handle) {
  userHandleSpan.textContent = `@${handle}`;
  userProfile.classList.remove('hidden');
}
