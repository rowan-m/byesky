import { CRITERIA, FILTER_CONTROLS } from '../criteria.js';
import { clampParam } from '../scoring.js';
import { state } from './state.js';
import { renderDashboard } from './table.js';

const CONFIG_COLLAPSED_KEY = 'byesky:configCollapsed';
// Keep in sync with the narrow-layout breakpoint in style.css.
const narrowLayoutQuery = window.matchMedia('(max-width: 1100px)');

const PARAM_INPUTS = {
  'param-inactive-days': 'inactiveDays',
  'param-low-followers': 'lowFollowersThreshold',
  'param-noisy-posts': 'noisyPostsThreshold',
  'param-mass-follower': 'massFollowerThreshold',
};

export function setupConfigListeners() {
  // Live weight adjustments
  for (const { id, weightId } of CRITERIA) {
    const slider = document.getElementById(weightId);
    if (!slider) continue;

    slider.addEventListener('input', (e) => {
      state.weights[id] = parseInt(e.target.value, 10);
      renderDashboard(); // Re-render table and update scores instantly
    });

    enhanceWeightControl(slider);
  }

  // Filter checkboxes
  for (const { key, filterId } of FILTER_CONTROLS) {
    const checkbox = document.getElementById(filterId);
    if (!checkbox) continue;

    const parentItem = checkbox.closest('.criteria-item');
    if (parentItem) {
      parentItem.classList.toggle('is-filtered-out', !checkbox.checked);
    }
    checkbox.addEventListener('change', (e) => {
      state.filters[key] = e.target.checked;
      if (parentItem) {
        parentItem.classList.toggle('is-filtered-out', !e.target.checked);
      }
      state.pagination.currentPage = 1; // Reset to page 1 on filter
      updateConfigSummary();
      renderDashboard();
    });
  }

  setupConfigPanel();

  // Parameters (debounced on input so multi-digit edits don't re-render on every keystroke)
  for (const [id, key] of Object.entries(PARAM_INPUTS)) {
    const input = document.getElementById(id);
    if (!input) continue;
    let paramTimeout = null;
    input.addEventListener('input', () => {
      clearTimeout(paramTimeout);
      // Leave an empty or half-typed field alone; clamp when it's a number.
      if (input.value.trim() === '') return;
      paramTimeout = setTimeout(() => {
        state.params[key] = clampParam(key, input.value);
        renderDashboard();
      }, 150);
    });
    input.addEventListener('change', () => {
      clearTimeout(paramTimeout);
      state.params[key] = clampParam(key, input.value);
      input.value = String(state.params[key]);
      renderDashboard();
    });
  }
}

/**
 * Renders a 0–5 segmented radio group in place of a range slider. The (hidden) range
 * input remains the source of truth, so existing `input` listeners keep working.
 */
function enhanceWeightControl(slider) {
  const min = parseInt(slider.min, 10) || 0;
  const max = parseInt(slider.max, 10) || 5;

  const group = document.createElement('div');
  group.className = 'weight-seg';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', slider.getAttribute('aria-label') || 'Weight');

  const buttons = [];
  for (let v = min; v <= max; v++) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'weight-seg-btn';
    btn.textContent = String(v);
    btn.dataset.value = String(v);
    btn.setAttribute('role', 'radio');
    buttons.push(btn);
    group.appendChild(btn);
  }

  const sync = () => {
    const current = slider.value;
    buttons.forEach((btn) => {
      const isActive = btn.dataset.value === current;
      btn.setAttribute('aria-checked', String(isActive));
      btn.tabIndex = isActive ? 0 : -1; // roving tabindex
    });
  };

  const select = (value, focus = false) => {
    const clamped = Math.min(max, Math.max(min, value));
    if (String(clamped) !== slider.value) {
      slider.value = String(clamped);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }
    sync();
    if (focus) buttons[clamped - min].focus();
  };

  group.addEventListener('click', (e) => {
    const btn = e.target.closest('.weight-seg-btn');
    if (btn) select(parseInt(btn.dataset.value, 10));
  });

  group.addEventListener('keydown', (e) => {
    const current = parseInt(slider.value, 10);
    const keyMap = {
      ArrowRight: current + 1,
      ArrowUp: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current - 1,
      Home: min,
      End: max,
    };
    if (e.key in keyMap) {
      e.preventDefault();
      select(keyMap[e.key], true);
    }
  });

  slider.classList.add('visually-hidden');
  slider.tabIndex = -1;
  slider.setAttribute('aria-hidden', 'true');
  slider.insertAdjacentElement('afterend', group);
  sync();
}

function readStoredConfigCollapsed() {
  try {
    return localStorage.getItem(CONFIG_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function storeConfigCollapsed(collapsed) {
  try {
    localStorage.setItem(CONFIG_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Storage unavailable (e.g. privacy mode); preference just won't persist.
  }
}

// Page regions made inert while the narrow-screen sheet is open (modal behaviour).
const CONFIG_OVERLAY_INERT_SELECTORS = ['.app-header', '.dashboard-main', '.app-footer'];

function setConfigOverlay(overlay) {
  const panel = document.getElementById('config-panel');
  const backdrop = document.getElementById('config-backdrop');
  if (overlay && panel) {
    // Pin the expanded sheet exactly where the bar currently sits so it can be sized
    // against the visible viewport (a sticky element's offset varies with scroll).
    const rect = panel.getBoundingClientRect();
    const root = document.documentElement.style;
    root.setProperty('--config-panel-top', `${Math.max(0, Math.round(rect.top))}px`);
    root.setProperty('--config-panel-left', `${Math.round(rect.left)}px`);
    root.setProperty('--config-panel-w', `${Math.round(rect.width)}px`);
    root.setProperty('--config-bar-h', `${Math.round(rect.height)}px`);
  }
  document.documentElement.classList.toggle('is-config-overlay', overlay);
  if (backdrop) backdrop.hidden = !overlay;

  if (panel) {
    if (overlay) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      panel.setAttribute('aria-label', 'Criteria & Scoring');
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      panel.removeAttribute('aria-label');
    }
  }
  CONFIG_OVERLAY_INERT_SELECTORS.forEach((selector) => {
    document.querySelector(selector)?.toggleAttribute('inert', overlay);
  });
}

function setConfigCollapsed(collapsed) {
  // Measure before toggling classes so the sheet is anchored to the collapsed bar.
  setConfigOverlay(narrowLayoutQuery.matches && !collapsed);
  document.querySelector('.dashboard-grid')?.classList.toggle('is-config-collapsed', collapsed);
  document.getElementById('config-toggle')?.setAttribute('aria-expanded', String(!collapsed));
}

/** Narrow screens always start collapsed; wide screens restore the user's last choice. */
function applyConfigLayout() {
  setConfigCollapsed(narrowLayoutQuery.matches ? true : readStoredConfigCollapsed());
}

function setupConfigPanel() {
  const toggle = document.getElementById('config-toggle');
  const grid = document.querySelector('.dashboard-grid');
  if (!toggle || !grid) return;

  const isOverlayOpen = () =>
    narrowLayoutQuery.matches && !grid.classList.contains('is-config-collapsed');
  const closeOverlay = () => {
    setConfigCollapsed(true);
    toggle.focus();
  };

  toggle.addEventListener('click', () => {
    const collapsed = !grid.classList.contains('is-config-collapsed');
    setConfigCollapsed(collapsed);
    if (!narrowLayoutQuery.matches) storeConfigCollapsed(collapsed);
  });

  // Escape closes the expanded overlay-style panel on narrow screens.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOverlayOpen()) closeOverlay();
  });

  // The backdrop is a real element so taps outside the sheet are absorbed rather than
  // activating whatever is underneath (rows, lock toggles, the batch Unfollow button).
  document.getElementById('config-backdrop')?.addEventListener('click', closeOverlay);

  narrowLayoutQuery.addEventListener('change', applyConfigLayout);

  // Re-anchor the open sheet when the width changes (e.g. rotation). Height-only
  // resizes (mobile browser chrome showing/hiding) are handled by dvh.
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    if (isOverlayOpen()) {
      const body = document.getElementById('config-body');
      const scrollTop = body?.scrollTop ?? 0;
      grid.classList.add('is-config-collapsed');
      setConfigOverlay(true);
      grid.classList.remove('is-config-collapsed');
      if (body) body.scrollTop = scrollTop;
    }
  });
  applyConfigLayout();
  updateConfigSummary();

  // Expose the sticky header height so the sticky sidebar/top bar can sit beneath it.
  const header = document.querySelector('.app-header');
  if (header && 'ResizeObserver' in window) {
    new window.ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--header-h', `${height}px`);
    }).observe(header);
  }

  // Expose the panel's height so, on wide screens, a panel taller than the window sticks
  // with its bottom in view instead of needing its own scrollbar.
  const panel = document.getElementById('config-panel');
  if (panel && 'ResizeObserver' in window) {
    new window.ResizeObserver(([entry]) => {
      const height = Math.ceil(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty('--sidebar-h', `${height}px`);
    }).observe(panel);
  }
}

export function updateConfigSummary() {
  const summary = document.getElementById('config-summary');
  if (!summary) return;
  const hiddenCount = Object.values(state.filters).filter((shown) => !shown).length;
  const plural = hiddenCount === 1 ? '' : 's';
  summary.textContent = hiddenCount === 0 ? 'All shown' : `${hiddenCount} filter${plural} off`;
  summary.classList.toggle('has-hidden', hiddenCount > 0);
}

export function initializeStateFromDOM() {
  for (const { id, weightId, defaultWeight } of CRITERIA) {
    const el = document.getElementById(weightId);
    const parsed = el ? parseInt(el.value, 10) : NaN;
    state.weights[id] = Number.isNaN(parsed) ? defaultWeight : parsed;
  }

  for (const { key, filterId } of FILTER_CONTROLS) {
    const el = document.getElementById(filterId);
    if (el) state.filters[key] = el.checked;
  }

  for (const [id, key] of Object.entries(PARAM_INPUTS)) {
    const el = document.getElementById(id);
    if (el) state.params[key] = clampParam(key, el.value);
  }
}
