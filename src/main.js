import { setupActionListeners } from './app/actions.js';
import { initializeStateFromDOM, setupConfigListeners } from './app/config-panel.js';
import { loginError } from './app/dom.js';
import { setupPreviewListeners } from './app/preview.js';
import { checkSession, setupSessionListeners } from './app/session.js';
import { setupSyncListeners } from './app/sync-ui.js';
import { setupTableListeners } from './app/table.js';

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

  // Handle errors redirected back from OAuth flow
  const urlParams = new URLSearchParams(window.location.search);
  const callbackError = urlParams.get('error');
  if (callbackError) {
    loginError.textContent = decodeURIComponent(callbackError);
    loginError.classList.remove('hidden');
    // Clear URL parameters without triggering a reload
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  await checkSession();
});
