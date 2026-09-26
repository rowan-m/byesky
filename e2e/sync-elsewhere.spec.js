// A second tab mirrors a sync another tab is running instead of starting its own.
import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

test('explains itself and hides controls that only work in the syncing tab', async ({ page }) => {
  await mockSignedInApp(page, {
    syncState: {
      status: 'enriching',
      runningElsewhere: true,
      completedAt: Date.parse('2026-01-02T10:30:00Z'),
      progress: {
        total: 40,
        processed: 10,
        currentStage: 'Analyzing activity (10/40)...',
        step: { id: 'activity', index: 6, total: 6, label: 'Checking recent activity' },
      },
    },
  });
  await page.goto('/');
  await expect(page.locator('#sync-section')).toBeVisible();
  await expect(page.locator('#sync-elsewhere')).toBeVisible();
  await expect(page.locator('#cancel-sync-btn')).toBeHidden();
  await expect(page.locator('#skip-mutuals')).toBeHidden();
  // The previous completed sync, not the one in progress.
  await expect(page.locator('#last-synced-time')).toContainText('Last synced');
});
