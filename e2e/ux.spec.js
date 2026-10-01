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

test('unfollowed filter toggles visibility of unfollowed accounts', async ({ page }) => {
  const firstRow = page.locator('#table-body tr').first();
  const did = await firstRow.getAttribute('data-did');

  await firstRow.locator('.unfollow-single-btn').click();
  await expect(page.locator('#action-toast')).toContainText('Unfollowed 1 account.');

  const unfollowedRow = page.locator(`#table-body tr[data-did="${did}"]`);
  await expect(unfollowedRow).toBeVisible();
  await expect(unfollowedRow).toHaveClass(/unfollowed-row/);
  await expect(unfollowedRow.locator('.col-checkbox .refollow-single-btn')).toBeVisible();

  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }

  // Uncheck "Unfollowed" filter to hide it
  const unfollowedFilter = page.locator('#filter-unfollowed');
  await unfollowedFilter.uncheck();
  if (page.viewportSize().width <= 1100) {
    await page.keyboard.press('Escape');
  }
  await expect(unfollowedRow).toBeHidden();

  // Re-check "Unfollowed" filter to restore visibility
  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }
  await unfollowedFilter.check();
  if (page.viewportSize().width <= 1100) {
    await page.keyboard.press('Escape');
  }
  await expect(unfollowedRow).toBeVisible();
});

test('grouped row controls live in .col-checkbox and keyboard triage shortcuts work end-to-end', async ({
  page,
}) => {
  // No right-hand Action column
  await expect(page.locator('th.col-action, td.col-action')).toHaveCount(0);

  const rows = page.locator('#table-body tr');
  const firstRow = rows.nth(0);
  const secondRow = rows.nth(1);
  const thirdRow = rows.nth(2);

  // Select, lock, and unfollow controls are grouped inside .col-checkbox
  await expect(firstRow.locator('.col-checkbox .row-checkbox')).toBeVisible();
  await expect(firstRow.locator('.col-checkbox .lock-toggle-btn')).toBeVisible();
  await expect(firstRow.locator('.col-checkbox .unfollow-single-btn')).toHaveText('👋');

  // Toggle keyboard shortcuts legend with ?
  const legend = page.locator('#shortcuts-legend');
  await expect(legend).toBeHidden();
  await page.keyboard.press('?');
  await expect(legend).toBeVisible();
  await page.keyboard.press('?');
  await expect(legend).toBeHidden();

  // Navigate rows with J/K, W/S, and ArrowDown/ArrowUp
  await page.keyboard.press('j');
  await expect(firstRow).toHaveClass(/active-row/);

  await page.keyboard.press('s');
  await expect(secondRow).toHaveClass(/active-row/);

  await page.keyboard.press('ArrowDown');
  await expect(thirdRow).toHaveClass(/active-row/);

  await page.keyboard.press('w');
  await expect(secondRow).toHaveClass(/active-row/);

  await page.keyboard.press('k');
  await expect(firstRow).toHaveClass(/active-row/);

  // Space selects the active row; Shift+ArrowDown range-selects the next row
  await page.keyboard.press(' ');
  await expect(firstRow).toHaveClass(/selected-row/);
  await expect(page.locator('#selected-count')).toHaveText('1');

  await page.keyboard.press('Shift+ArrowDown');
  await expect(secondRow).toHaveClass(/active-row/);
  await expect(secondRow).toHaveClass(/selected-row/);
  await expect(page.locator('#selected-count')).toHaveText('2');

  // L locks the active row (secondRow), clearing its selection and disabling its unfollow button
  await page.keyboard.press('l');
  await expect(secondRow).toHaveClass(/locked-row/);
  await expect(secondRow.locator('.unfollow-single-btn')).toBeDisabled();
  await expect(page.locator('#selected-count')).toHaveText('1');

  // L again unlocks it
  await page.keyboard.press('l');
  await expect(secondRow).not.toHaveClass(/locked-row/);
  await expect(secondRow.locator('.unfollow-single-btn')).toBeEnabled();

  // U unfollows the active row and swaps in the Re-follow pill in .col-checkbox; Z undoes it
  await page.keyboard.press('u');
  await expect(secondRow).toHaveClass(/unfollowed-row/);
  await expect(secondRow.locator('.col-checkbox .refollow-single-btn')).toBeVisible();
  await page.keyboard.press('z');
  await expect(secondRow).not.toHaveClass(/unfollowed-row/);
  await expect(secondRow.locator('.col-checkbox .unfollow-single-btn')).toBeVisible();

  // I opens the preview sheet for the active row, and J live-updates the preview to the next row
  const secondDid = await secondRow.getAttribute('data-did');
  const thirdDid = await thirdRow.getAttribute('data-did');
  const secondName = await secondRow.locator('.display-name').innerText();
  const thirdName = await thirdRow.locator('.display-name').innerText();
  await page.keyboard.press('i');
  const previewSheet = page.locator('#preview-sheet');
  await expect(previewSheet).toBeVisible();
  await expect(previewSheet).toHaveAttribute('data-did', secondDid);
  await expect(previewSheet).toContainText(secondName);

  await page.keyboard.press('j');
  await expect(thirdRow).toHaveClass(/active-row/);
  await expect(previewSheet).toHaveAttribute('data-did', thirdDid);
  await expect(previewSheet).toContainText(thirdName);

  await page.keyboard.press('Escape');
  await expect(previewSheet).toBeHidden();
});

test('when Unfollowed filter is off, unfollowing with U keeps cursor at the same row index', async ({
  page,
}) => {
  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }
  await page.locator('#filter-unfollowed').uncheck();
  if (page.viewportSize().width <= 1100) {
    await page.keyboard.press('Escape');
  }

  const rows = page.locator('#table-body tr');
  const secondDidBefore = await rows.nth(1).getAttribute('data-did');
  const thirdDidBefore = await rows.nth(2).getAttribute('data-did');

  // Move cursor to row index 1 (second row)
  await page.keyboard.press('j');
  await page.keyboard.press('j');
  await expect(rows.nth(1)).toHaveAttribute('data-did', secondDidBefore);
  await expect(rows.nth(1)).toHaveClass(/active-row/);

  // Press U: secondDidBefore is unfollowed and hidden; thirdDidBefore slides into index 1 and stays active
  await page.keyboard.press('u');
  await expect(rows.nth(1)).toHaveAttribute('data-did', thirdDidBefore);
  await expect(rows.nth(1)).toHaveClass(/active-row/);
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

test('login button disables and shows Connecting... while resolving handle, and resets on error', async ({
  page,
}) => {
  await page.unroute('**/src/auth.js');
  await page.route(
    (url) => url.pathname === '/src/auth.js',
    (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `
          export function initOAuthClient() {
            return {
              async init() { return {}; },
              signIn(handle) {
                window.__signInHandle = handle;
                return new Promise((_, reject) => {
                  window.__rejectSignIn = () => reject(new Error('Could not resolve handle'));
                });
              },
            };
          }
        `,
      }),
  );
  await page.route('**/xrpc/app.bsky.actor.searchActorsTypeahead*', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ actors: [{ handle: 'rowan.fyi', avatar: '' }] }),
    }),
  );
  await page.goto('/');
  const loginHandle = page.locator('#login-handle');
  const loginBtn = page.locator('#login-btn');

  const typeaheadResponse = page.waitForResponse('**/xrpc/app.bsky.actor.searchActorsTypeahead*');
  await loginHandle.fill('rowan');
  await typeaheadResponse;
  await loginHandle.press('ArrowDown');
  await loginHandle.press('Enter');
  await expect(loginHandle).toHaveValue('rowan.fyi');
  await expect(loginBtn).toBeEnabled();

  await loginHandle.press('Enter');

  await expect(loginBtn).toBeDisabled();
  await expect(loginBtn).toHaveText('Connecting...');
  await expect(loginHandle).toBeDisabled();

  await page.evaluate(() => window.__rejectSignIn());

  await expect(loginBtn).toBeEnabled();
  await expect(loginBtn).toHaveText('Connect with Bluesky');
  await expect(loginHandle).toBeEnabled();
  await expect(page.locator('#login-error')).toContainText('Could not resolve handle');
});

test('SEO metadata, OpenGraph preview image, and JSON-LD structured data are present and served', async ({
  page,
  request,
}) => {
  await expect(page).toHaveTitle('Nimbye — Clean up who you follow on Bluesky');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    'content',
    'Nimbye — Clean up who you follow on Bluesky',
  );
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
    'content',
    'https://nimbye.web.app/og-image.png',
  );
  await expect(page.locator('meta[property="og:logo"]')).toHaveAttribute(
    'content',
    'https://nimbye.web.app/icon.png',
  );
  const metaDesc = await page.locator('meta[name="description"]').getAttribute('content');
  const ogDesc = await page.locator('meta[property="og:description"]').getAttribute('content');
  expect(metaDesc.length).toBeGreaterThanOrEqual(70);
  expect(metaDesc.length).toBeLessThanOrEqual(125);
  expect(ogDesc.length).toBeLessThanOrEqual(125);

  const jsonLdText = await page.locator('script[type="application/ld+json"]').textContent();
  const jsonLd = JSON.parse(jsonLdText);
  expect(jsonLd['@type']).toBe('WebApplication');
  expect(jsonLd.name).toBe('Nimbye');

  for (const assetPath of [
    '/og-image.png',
    '/favicon.ico',
    '/icon.png',
    '/icon.svg',
    '/robots.txt',
    '/sitemap.xml',
    '/site.webmanifest',
  ]) {
    const res = await request.get(assetPath);
    expect(res.status(), `Expected 200 for ${assetPath}`).toBe(200);
  }
});

test('custom weights, filters, and thresholds persist across reloads and Reset defaults restores them', async ({
  page,
}) => {
  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }

  const resetBtn = page.locator('#reset-config-btn');
  await expect(resetBtn).toBeHidden();

  // Customize a weight, a filter, and a threshold parameter
  await page.locator('#weight-not-following + .weight-seg .weight-seg-btn[data-value="5"]').click();
  await page.locator('#filter-noisy').uncheck();
  await page.locator('#param-inactive-days').fill('90');
  await page.locator('#param-inactive-days').dispatchEvent('change');

  await expect(resetBtn).toBeVisible();

  // Reload the page and verify preferences are restored from localStorage
  await page.reload();
  await expect(page.locator('#table-body tr').first()).toBeVisible();

  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }

  await expect(
    page.locator('#weight-not-following + .weight-seg .weight-seg-btn[data-value="5"]'),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#filter-noisy')).not.toBeChecked();
  await expect(page.locator('#param-inactive-days')).toHaveValue('90');
  await expect(resetBtn).toBeVisible();

  // Click Reset defaults: modal opens, Cancel dismisses without resetting
  await resetBtn.click();
  const resetModal = page.locator('#reset-confirm-modal');
  await expect(resetModal).toBeVisible();
  await page.locator('#reset-modal-cancel-btn').click();
  await expect(resetModal).toBeHidden();
  await expect(resetBtn).toBeVisible();

  // Click Reset defaults again and confirm: resets to defaults and hides resetBtn
  await resetBtn.click();
  await expect(resetModal).toBeVisible();
  await page.locator('#reset-modal-confirm-btn').click();
  await expect(resetModal).toBeHidden();
  await expect(resetBtn).toBeHidden();
  await expect(
    page.locator('#weight-not-following + .weight-seg .weight-seg-btn[data-value="1"]'),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#filter-noisy')).toBeChecked();
  await expect(page.locator('#param-inactive-days')).toHaveValue('180');
});

test('clicking a criterion badge or sidebar Only button solos that filter and clicking again restores all criteria', async ({
  page,
}) => {
  const rows = page.locator('#table-body tr');
  await expect(rows).toHaveCount(25);

  // Click a NEVER POSTED badge in the table to solo-filter to neverPosted accounts
  const neverPostedBadge = page
    .locator('#table-body button.badge-filter[data-filter-key="neverPosted"]')
    .first();
  await neverPostedBadge.click();

  await expect(page.locator('#config-summary')).toHaveText('Only: Never Posted');
  const soloTotal = await rows.count();
  expect(soloTotal).toBeGreaterThan(0);
  expect(soloTotal).toBeLessThan(25);

  // Every visible row should have the active solo badge
  const activeBadges = page.locator(
    '#table-body button.badge-filter[data-filter-key="neverPosted"].is-solo-filter',
  );
  await expect(activeBadges).toHaveCount(soloTotal);

  // Clicking the active badge again restores all filters
  await activeBadges.first().click();
  await expect(page.locator('#config-summary')).toHaveText('All shown');
  await expect(rows).toHaveCount(25);

  // Test sidebar Only / All button toggle
  if (page.viewportSize().width <= 1100) {
    await page.locator('#config-toggle').click();
  }
  // Uncheck noisy poster
  await page.locator('#filter-noisy').uncheck();
  // Click Only on muted account
  const mutedOnlyBtn = page.locator('.criteria-only-btn[data-filter-key="muted"]');
  await mutedOnlyBtn.click();
  await expect(mutedOnlyBtn).toHaveText('All');
  await expect(page.locator('#filter-muted')).toBeChecked();
  await expect(page.locator('#filter-noisy')).not.toBeChecked();

  // Click All: ALL criteria should now be enabled
  await mutedOnlyBtn.click();
  await expect(mutedOnlyBtn).toHaveText('Only');
  await expect(page.locator('#filter-noisy')).toBeChecked();
  await expect(page.locator('#filter-muted')).toBeChecked();
});

test('batch unfollow Undo uses batchFollow in a single call', async ({ page }) => {
  await page.locator('#table-body .row-checkbox').nth(0).check();
  await page.locator('#table-body .row-checkbox').nth(1).check();
  await page.locator('#batch-unfollow-btn').click();

  const toast = page.locator('#action-toast');
  await expect(toast).toContainText('Unfollowed 2 accounts.');

  await toast.getByRole('button', { name: 'Undo' }).click();
  await expect(toast).toContainText('Re-followed 2 accounts.');

  const batchFollowCalls = await page.evaluate(() => window.__batchFollowCalls || []);
  expect(batchFollowCalls).toHaveLength(1);
  expect(batchFollowCalls[0]).toHaveLength(2);
});

test('Retry Incomplete header button and cancelled sync partial-results view work end-to-end', async ({
  page,
}) => {
  // 1. Account with incomplete data shows Retry Incomplete (1) in the header
  await mockSignedInApp(page, {
    count: 10,
    patches: { 0: { criteria: { unknown: ['activity'] } } },
  });
  await page.goto('/');
  const retryIncompleteBtn = page.locator('#retry-incomplete-btn');
  await expect(retryIncompleteBtn).toBeVisible();
  await expect(page.locator('#incomplete-count')).toHaveText('1');

  await retryIncompleteBtn.click();
  const incompleteStarts = await page.evaluate(() => window.__incompleteSyncStarts || 0);
  expect(incompleteStarts).toBe(1);

  // 2. Cancelled sync with partial followings offers Resume Incomplete and View Partial Results
  await mockSignedInApp(page, {
    count: 8,
    syncState: { status: 'cancelled', error: 'Synchronization aborted by user.' },
  });
  await page.goto('/');
  await expect(page.locator('#sync-section')).toBeVisible();
  await expect(page.locator('#resume-sync-btn')).toBeVisible();
  await expect(page.locator('#view-partial-btn')).toBeVisible();

  await page.locator('#view-partial-btn').click();
  await expect(page.locator('#dashboard-section')).toBeVisible();
  await expect(page.locator('#table-body tr')).toHaveCount(8);
});
