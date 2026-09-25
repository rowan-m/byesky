import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

test.beforeEach(async ({ page }) => {
  await mockSignedInApp(page, { count: 25 });
  await page.goto('/');
  await expect(page.locator('#table-body tr').first()).toBeVisible();
});

test('selection survives weight, parameter, and sort changes, and prunes hidden rows on search', async ({
  page,
}) => {
  const firstCheckbox = page.locator('#table-body .row-checkbox').nth(0);
  const secondCheckbox = page.locator('#table-body .row-checkbox').nth(1);
  const firstDid = await firstCheckbox.getAttribute('data-did');

  await firstCheckbox.check();
  await secondCheckbox.check();
  await expect(page.locator('#selected-count')).toHaveText('2');
  await expect(page.locator('#table-body tr').first()).toHaveClass(/selected-row/);

  // Open the criteria panel on narrow viewports so weight/param controls are visible
  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }

  // Changing a weight must NOT clear the selection
  await page.locator('#weight-not-following + .weight-seg .weight-seg-btn[data-value="3"]').click();
  await expect(page.locator('#selected-count')).toHaveText('2');

  // Changing a threshold parameter must NOT clear the selection
  await page.locator('#param-inactive-days').fill('90');
  await page.locator('#param-inactive-days').dispatchEvent('change');
  await expect(page.locator('#selected-count')).toHaveText('2');

  if (page.viewportSize().width <= 1100) {
    await page.keyboard.press('Escape');
  }

  // Changing sort order must NOT clear the selection
  await page.locator('th[data-sort="followers"] .sort-btn').click();
  await expect(page.locator('th[data-sort="followers"]')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('#selected-count')).toHaveText('2');

  // Filtering via search to only the first selected account prunes the hidden one
  const firstNum = firstDid.replace('did:plc:acct', '');
  await page.locator('#table-search').fill(`account-${firstNum}.bsky.social`);
  await expect(page.locator('#selected-count')).toHaveText('1');
});

test('focus is preserved on row controls across re-renders', async ({ page }) => {
  const lockBtn = page.locator('#table-body .lock-toggle-btn').first();
  const did = await lockBtn.getAttribute('data-did');

  await lockBtn.focus();
  await page.keyboard.press('Enter');

  const updatedLockBtn = page.locator(`#table-body .lock-toggle-btn[data-did="${did}"]`);
  await expect(updatedLockBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(updatedLockBtn).toBeFocused();
});

test('batch unfollow confirmation uses native dialog and Escape cancels', async ({ page }) => {
  await page.locator('#select-all').check();
  await expect(page.locator('#selected-count')).toHaveText('25');

  await page.locator('#batch-unfollow-btn').click();
  const dialog = page.locator('#confirm-modal');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#modal-cancel-btn')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#selected-count')).toHaveText('25');
});

test('unfollow shows status toast with Undo, and reports partial failures with Retry', async ({
  page,
}) => {
  const firstRow = page.locator('#table-body tr').first();
  const did = await firstRow.getAttribute('data-did');

  await firstRow.locator('.unfollow-single-btn').click();
  const toast = page.locator('#action-toast');
  await expect(toast).toBeVisible();
  await expect(toast).toContainText('Unfollowed 1 account.');

  // Undo restores the follow
  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Re-followed 1 account.');
  await expect(
    page.locator(`#table-body tr[data-did="${did}"] .unfollow-single-btn`),
  ).toBeVisible();

  // Partial failure surfaces an alert toast with Retry failed + Undo
  await page.evaluate(() => {
    window.__batchUnfollow = async (dids) => ({
      success: [dids[0]],
      failed: [{ did: dids[1], error: 'Rate limit exceeded' }],
    });
  });

  await page.locator('#table-body .row-checkbox').nth(0).check();
  await page.locator('#table-body .row-checkbox').nth(1).check();
  await page.locator('#batch-unfollow-btn').click();

  await expect(toast).toHaveAttribute('role', 'alert');
  await expect(toast).toContainText('Unfollowed 1, 1 failed.');
  await expect(toast.getByRole('button', { name: 'Retry failed' })).toBeVisible();
  await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
});

test('malformed percent in OAuth error query parameter does not crash startup', async ({
  page,
}) => {
  await page.unroute('**/src/auth.js');
  await page.route(
    (url) => url.pathname === '/src/auth.js',
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: 'export function initOAuthClient() { return { async init() { return {}; } }; }',
      }),
  );
  await page.goto('/?error=100%25+failed');
  await expect(page.locator('#auth-section')).toBeVisible();
  await expect(page.locator('#login-error')).toContainText('100% failed');
});
