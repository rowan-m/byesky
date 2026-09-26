// Browser-level layout tests. The OAuth client and @atproto/api module are replaced with
// fakes (see fixtures.js) and the sync cache is seeded, so no network or sign-in is needed.
import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';
import { OAUTH_SCOPE } from '../src/scopes.js';

test.beforeEach(async ({ page }) => {
  await mockSignedInApp(page);
  await page.goto('/');
  await expect(page.locator('#table-body tr').first()).toBeVisible();
});

const isNarrow = (page) => page.viewportSize().width <= 1100;

test('criteria panel controls are all reachable', async ({ page }) => {
  const toggle = page.locator('#config-toggle');
  const panel = page.locator('#config-panel');
  const body = page.locator('#config-body');

  if (isNarrow(page)) {
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  const viewportHeight = page.viewportSize().height;
  if (isNarrow(page)) {
    // Overlay sheet must fit the viewport (it scrolls internally).
    const box = await panel.boundingBox();
    expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight + 1);
  }

  const lastInput = body.locator('input').last();
  await lastInput.scrollIntoViewIfNeeded();
  const inputBox = await lastInput.boundingBox();
  expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(viewportHeight + 1);
  await expect(lastInput).toBeInViewport();
});

test('wide panel has no inner scrollbar and its bottom sticks in view', async ({ page }) => {
  test.skip(isNarrow(page), 'Wide layouts only');
  // Short window so the panel is taller than the viewport.
  await page.setViewportSize({ width: page.viewportSize().width, height: 600 });

  const body = page.locator('#config-body');
  const hasInnerScroll = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(hasInnerScroll).toBe(false);

  // Scroll well down the table: the panel's bottom should be pinned inside the viewport.
  await page.mouse.move(page.viewportSize().width - 50, 300);
  await page.mouse.wheel(0, 2000);
  await expect
    .poll(async () => {
      const box = await page.locator('#config-panel').boundingBox();
      return Math.round(box.y + box.height);
    })
    .toBeLessThanOrEqual(600);
  await expect(body.locator('input').last()).toBeInViewport();
});

test('criteria panel still fits after scrolling the page', async ({ page }) => {
  test.skip(!isNarrow(page), 'Sticky/overlay behaviour only applies to narrow layouts');
  await page.mouse.wheel(0, 600);
  await page.locator('#config-toggle').click();
  const box = await page.locator('#config-panel').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
});

test('narrow overlay is modal and backdrop taps do not fall through', async ({ page }) => {
  test.skip(!isNarrow(page), 'Overlay only applies to narrow layouts');
  const toggle = page.locator('#config-toggle');
  await toggle.click();

  const panel = page.locator('#config-panel');
  await expect(panel).toHaveAttribute('role', 'dialog');
  await expect(panel).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('.dashboard-main')).toHaveAttribute('inert', '');

  // Tap where a row checkbox sits under the backdrop: it must close the sheet only.
  const checkbox = page.locator('#table-body .row-checkbox').last();
  const cbBox = await checkbox.boundingBox();
  const vh = page.viewportSize().height;
  const panelBox = await panel.boundingBox();
  // Tap in the backdrop strip below the sheet (or near the bottom edge if the sheet is full height).
  const tapY = Math.min(vh - 2, panelBox.y + panelBox.height + 2);
  const tapX = cbBox ? cbBox.x + cbBox.width / 2 : 20;
  const hitId = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [tapX, tapY]);
  expect(hitId).toBe('config-backdrop');
  await page.mouse.click(tapX, tapY);

  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#table-body .row-checkbox:checked')).toHaveCount(0);
  await expect(page.locator('.dashboard-main')).not.toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
});

test('escape closes the narrow overlay and restores focus', async ({ page }) => {
  test.skip(!isNarrow(page), 'Overlay only applies to narrow layouts');
  const toggle = page.locator('#config-toggle');
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(toggle).toBeFocused();
});

test('wide layout collapses to a rail and persists the choice', async ({ page }) => {
  test.skip(isNarrow(page), 'Rail only applies to wide layouts');
  const toggle = page.locator('#config-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect((await page.locator('#config-panel').boundingBox()).width).toBeLessThan(60);
  await page.reload();
  await expect(page.locator('#config-toggle')).toHaveAttribute('aria-expanded', 'false');
});

test('table does not overflow horizontally', async ({ page }) => {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test('account preview opens from the preview button', async ({ page, hasTouch }) => {
  const button = page.locator('#table-body .preview-btn').first();
  if (hasTouch) {
    await expect(button).toBeVisible();
    await button.tap();
  } else {
    // Mouse users get the hover card; the button is a keyboard fallback.
    await button.focus();
    await page.keyboard.press('Enter');
  }
  const sheet = page.locator('#preview-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(/Bio for Account \d+/);

  const { width: vw, height: vh } = page.viewportSize();
  const box = await sheet.boundingBox();
  if (vw <= 860) {
    expect(Math.abs(box.y + box.height - vh)).toBeLessThanOrEqual(2); // bottom sheet
  } else {
    expect(Math.abs(box.x + box.width / 2 - vw / 2)).toBeLessThanOrEqual(2); // centred
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('hover card shows on mouse hover', async ({ page, hasTouch }) => {
  test.skip(hasTouch, 'No hover on touch devices');
  await page.locator('#table-body .profile-cell').first().hover();
  await expect(page.locator('#profile-hover-card')).toBeVisible();
  await expect(page.locator('#profile-hover-card')).toContainText(/Bio for Account \d+/);
});

test.describe('session from before granular permissions', () => {
  test.beforeEach(async ({ page }) => {
    // Re-register routes with an older, broad grant.
    await page.unrouteAll();
    await mockSignedInApp(page, {
      grantedScope: 'atproto transition:generic repo:app.bsky.graph.follow',
    });
    await page.goto('/');
    await expect(page.locator('#table-body tr').first()).toBeVisible();
  });

  test('shows a re-auth prompt that starts sign-in', async ({ page }) => {
    const banner = page.locator('#reauth-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('narrowed its permissions');

    await page.locator('#reauth-btn').click();
    await expect
      .poll(() => page.evaluate(() => window.__signInCalls || []))
      .toEqual(['e2e-user.bsky.social']);
    expect(await page.evaluate(() => sessionStorage.getItem('byesky:resyncAfterReauth'))).toBe('1');
  });
});

test('names what a newly required scope is for', async ({ page }) => {
  const withoutChat = OAUTH_SCOPE.split(' ')
    .filter((s) => !s.startsWith('rpc:chat.'))
    .join(' ');
  await page.unrouteAll();
  await mockSignedInApp(page, { grantedScope: withoutChat });
  await page.goto('/');
  const banner = page.locator('#reauth-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('include direct messages in interaction scoring');
});

test('no re-auth prompt when all scopes are granted', async ({ page }) => {
  await expect(page.locator('#reauth-banner')).toBeHidden();
});

test('returning from re-auth with all scopes starts a fresh sync', async ({ page }) => {
  await page.evaluate(() => sessionStorage.setItem('byesky:resyncAfterReauth', '1'));
  await page.reload();
  await expect(page.locator('#sync-section')).toBeVisible();
  await expect(page.locator('#reauth-banner')).toBeHidden();
  expect(await page.evaluate(() => sessionStorage.getItem('byesky:resyncAfterReauth'))).toBeNull();
});
