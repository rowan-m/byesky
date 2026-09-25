import { setupActionListeners } from './app/actions.js';
import { initializeStateFromDOM, setupConfigListeners } from './app/config-panel.js';
import { loginError } from './app/dom.js';
import { setupPreviewListeners } from './app/preview.js';
import { checkSession, setupSessionListeners } from './app/session.js';
import { setupSyncListeners } from './app/sync-ui.js';
import { setupTableListeners } from './app/table.js';

const OAUTH_ERROR_MESSAGES = {
  access_denied: 'Sign-in was cancelled.',
  login_required: 'Please sign in again to continue.',
  consent_required: 'Sign-in requires your permission to continue.',
};

window.addEventListener('DOMContentLoaded', async () => {
  // Conforms with RFC 8252 loopback IP policies (which prohibit "localhost" hostnames)
  if (window.location.hostname === 'localhost') {
    window.location.replace(window.location.href.replace('localhost', '127.0.0.1'));
    return;
  }
  // OAuth client metadata is published for the *.web.app hostname, so sign-in only works
  // there. Send visitors on the equivalent *.firebaseapp.com hostname across.
  if (window.location.hostname.endsWith('.firebaseapp.com')) {
    const url = new URL(window.location.href);
    url.hostname = url.hostname.replace(/\.firebaseapp\.com$/, '.web.app');
    window.location.replace(url.href);
    return;
  }

  initializeStateFromDOM();
  setupSessionListeners();
  setupConfigListeners();
  setupSyncListeners();
  setupTableListeners();
  setupActionListeners();
  setupPreviewListeners();

  // Handle errors redirected back from OAuth flow (URLSearchParams already percent-decodes)
  const urlParams = new URLSearchParams(window.location.search);
  const callbackError = urlParams.get('error');
  if (callbackError) {
    const description = urlParams.get('error_description');
    loginError.textContent =
      OAUTH_ERROR_MESSAGES[callbackError] || description || `Sign-in failed (${callbackError}).`;
    loginError.classList.remove('hidden');
    // Clear URL parameters without triggering a reload
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  await checkSession();
});
