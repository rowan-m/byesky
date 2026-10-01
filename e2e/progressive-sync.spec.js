import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

test('progressive sync immediately shows dashboard and live updates rows', async ({ page }) => {
  // Mock signed in with 10 accounts starting in enriching status with pending profile/activity
  await mockSignedInApp(page, {
    count: 10,
    syncState: {
      status: 'enriching',
      progress: {
        total: 10,
        processed: 2,
        currentStage: 'Fetching profile statistics (2/10)...',
        step: { id: 'profiles', index: 5, total: 6, label: 'Fetching profile statistics' },
      },
    },
    patches: Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        i,
        {
          criteria: {
            followersCount: 0,
            lastPostDate: null,
            unknown: ['inbound', 'outbound', 'profile', 'activity'],
          },
        },
      ]),
    ),
  });

  await page.goto('/');

  // 1. Dashboard is immediately visible (NOT hidden behind full-page loader)
  await expect(page.locator('#dashboard-section')).toBeVisible();

  // 2. Sync banner is visible at the top
  const syncSection = page.locator('#sync-section');
  await expect(syncSection).toBeVisible();
  await expect(syncSection).toHaveClass(/sync-banner/);
  await expect(page.locator('#sync-stage')).toHaveText('Fetching profile statistics (2/10)...');

  // 3. Table rows are populated and rendered with pending indicators
  await expect(page.locator('#table-body tr')).toHaveCount(10);
  const initialRow = page.locator('#table-body tr').first();
  await expect(initialRow.locator('td.col-followers')).toContainText('~');
  await expect(initialRow.locator('td.col-followers span')).toHaveAttribute('title', 'Pending');
  await expect(initialRow.locator('td.col-last-post')).toContainText('~');
  await expect(initialRow.locator('td.col-last-interaction')).toContainText('None in last 5,000');
  await expect(initialRow.locator('td.col-last-interaction span')).toHaveAttribute(
    'title',
    /No interaction found in your last 5,000/,
  );
  const incompleteBadge = initialRow.locator('.flags-list .badge-info');
  await expect(incompleteBadge).toHaveText('INCOMPLETE');
  await expect(incompleteBadge).toHaveAttribute('title', /is in progress/);
  await expect(incompleteBadge).not.toHaveAttribute('title', /Retry Incomplete/);
  await expect(initialRow.locator('.flags-list')).not.toContainText('NO INBOUND');
  await expect(initialRow.locator('.flags-list')).not.toContainText('NO OUTBOUND');

  // 4. Simulate a progressive batch update with enriched criteria
  const targetDid = await page.evaluate(async () => {
    const { syncCache } = await import('/src/cache.js');
    const { onSyncUpdate } = await import('/src/app/sync-ui.js');
    const userDid = 'did:plc:e2euser';
    const cached = await syncCache.get(userDid);

    // Enrich first account with activity and mutuals
    cached.followings[0].criteria.followersCount = 5000;
    cached.followings[0].criteria.mutualsCount = 5;
    cached.followings[0].criteria.isOutlier = false;
    cached.followings[0].criteria.isInactive = true;
    cached.followings[0].criteria.unknown = [];
    cached.progress.processed = 6;
    cached.progress.currentStage = 'Analyzing activity (6/10)...';
    cached.progress.step = {
      id: 'activity',
      index: 6,
      total: 6,
      label: 'Checking recent activity',
    };

    const did = cached.followings[0].did;
    await syncCache.set(userDid, cached);
    onSyncUpdate();
    return did;
  });

  // 5. Verify the banner updates with the new stage
  await expect(page.locator('#sync-stage')).toHaveText('Analyzing activity (6/10)...');

  // 6. Verify row criteria badge and followers count updated live on the target account
  const targetRow = page.locator(`#table-body tr[data-did="${targetDid}"]`);
  await expect(targetRow.locator('td.col-flags')).toContainText('5 MUTUALS');
  await expect(targetRow.locator('td.col-followers')).toContainText('5,000');

  // 7. Verify sync completion cleanly dismisses the top banner
  await page.evaluate(async () => {
    const { syncCache } = await import('/src/cache.js');
    const { onSyncUpdate } = await import('/src/app/sync-ui.js');
    const userDid = 'did:plc:e2euser';
    const cached = await syncCache.get(userDid);
    cached.status = 'completed';
    cached.completedAt = Date.now();
    await syncCache.set(userDid, cached);
    onSyncUpdate();
  });

  await expect(syncSection).toBeHidden();
  await expect(page.locator('#dashboard-section')).toBeVisible();
});

test('hovering profile cell lazily hydrates mutuals and updates row score and badge live', async ({
  page,
  hasTouch,
}) => {
  test.skip(hasTouch, 'No hover on touch devices');
  // Start with completed sync where Account 7 has unknown mutualsCount
  await mockSignedInApp(page, {
    count: 10,
    patches: {
      7: {
        criteria: {
          mutualsCount: undefined,
          isOutlier: undefined,
          unknown: ['activity'],
        },
      },
    },
  });

  await page.goto('/');

  const targetRow = page.locator('#table-body tr[data-did="did:plc:acct7"]');
  await expect(targetRow).toBeVisible();

  // Initially, account has no mutuals badge
  await expect(targetRow.locator('td.col-flags')).not.toContainText('7 MUTUALS');

  // Hover over the profile-cell on the row to trigger hydratePreview
  await targetRow.locator('.profile-cell').hover();

  // Hover card appears
  const hoverCard = page.locator('#profile-hover-card');
  await expect(hoverCard).toBeVisible();

  // The row in the table is updated live with the new 7 MUTUALS badge
  await expect(targetRow.locator('td.col-flags')).toContainText('7 MUTUALS');
});
