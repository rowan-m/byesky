// Browser-level layout tests. The OAuth client and @atproto/api module are replaced with
// fakes (see fixtures.js) and the sync cache is seeded, so no network or sign-in is needed.
import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

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

  // Panel must fit the viewport, and the last control must be scrollable into view.
  const viewportHeight = page.viewportSize().height;
  const box = await panel.boundingBox();
  expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight + 1);

  const lastInput = body.locator('input').last();
  await lastInput.scrollIntoViewIfNeeded();
  const inputBox = await lastInput.boundingBox();
  expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(viewportHeight + 1);
  await expect(lastInput).toBeInViewport();
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
