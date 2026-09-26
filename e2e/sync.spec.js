// Sync progress screen: step numbering and the option to skip the mutuals lookup.
import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

const activityStep = {
  id: 'activity',
  index: 6,
  total: 6,
  label: 'Checking recent activity and mutual followers',
};

test.beforeEach(async ({ page }) => {
  await mockSignedInApp(page, {
    syncState: {
      status: 'enriching',
      skipMutuals: false,
      progress: {
        total: 40,
        processed: 10,
        currentStage: 'Analyzing activity (10/40)...',
        step: activityStep,
      },
    },
  });
  await page.goto('/');
  await expect(page.locator('#sync-section')).toBeVisible();
});

test('shows which step of the whole sync is running', async ({ page }) => {
  await expect(page.locator('#sync-step-title')).toHaveText(
    'Step 6 of 6: Checking recent activity and mutual followers',
  );
  const track = page.locator('#sync-progress-track');
  await expect(track).toHaveAttribute('role', 'progressbar');
  await expect(track).toHaveAttribute('aria-valuenow', '25');
  await expect(track).toHaveAttribute('aria-valuetext', 'Step 6 of 6, 25%');
});

test('mutual followers lookup can be skipped during the activity step', async ({ page }) => {
  const panel = page.locator('#skip-mutuals');
  await expect(panel).toBeVisible();

  await page.locator('#skip-mutuals-btn').click();

  await expect(panel).toBeHidden();
  await expect(page.locator('#sync-step-title')).toHaveText(
    'Step 6 of 6: Checking recent activity',
  );
  const skipFlag = await page.evaluate(async () => {
    const { syncCache } = await import('/src/cache.js');
    return (await syncCache.get('did:plc:e2euser')).skipMutuals;
  });
  expect(skipFlag).toBe(true);
});

test('cancelling stops the running sync and saves the cancelled state', async ({ page }) => {
  await page.locator('#cancel-sync-btn').click();
  await expect(page.locator('#sync-section')).toContainText('Sync Cancelled');
  expect(await page.evaluate(() => window.__syncCancels)).toBe(1);
  const status = await page.evaluate(async () => {
    const { syncCache } = await import('/src/cache.js');
    return (await syncCache.reload('did:plc:e2euser')).status;
  });
  expect(status).toBe('cancelled');
});

test('"Last synced" is blank while the first sync is still running', async ({ page }) => {
  await expect(page.locator('#last-synced-time')).toHaveText('');
});
