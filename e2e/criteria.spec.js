// Criteria badges come from the same evaluation as the score and the filters.
import { test, expect } from '@playwright/test';
import { mockSignedInApp } from './fixtures.js';

const clean = {
  isFollowingUser: true,
  isMassFollower: false,
  isNoisy: false,
  postsCount7Days: 2,
  userInteracted: true,
  userContactedThem: true,
  lastPostDate: new Date(Date.now() - 86400000).toISOString(),
  followersCount: 10, // below the Low Followers threshold, which has weight 0 by default
  followsCount: 10,
  mutualsCount: 3,
};

test.beforeEach(async ({ page }) => {
  await mockSignedInApp(page, {
    patches: {
      1: { criteria: clean },
      2: { criteria: { ...clean, lastPostDate: null, unknown: ['activity'] } },
    },
  });
  await page.goto('/');
  await expect(page.locator('#dashboard-section')).toBeVisible();
});

function rowFor(page, did) {
  return page.locator(`#table-body tr:has([data-did="${did}"])`);
}

test('zero-weight criteria do not stop an account being OK', async ({ page }) => {
  await page.getByPlaceholder('Search by name or handle...').fill('account-1.bsky.social');
  const flags = rowFor(page, 'did:plc:acct1').locator('.flags-list');
  await expect(flags.locator('.badge', { hasText: /^OK$/ })).toBeVisible();
  await expect(flags).not.toContainText('LOW FOLLOWERS');
});

test('a failed activity fetch is shown as incomplete, not never posted', async ({ page }) => {
  await page.getByPlaceholder('Search by name or handle...').fill('account-2.bsky.social');
  const row = rowFor(page, 'did:plc:acct2');
  const flags = row.locator('.flags-list');
  await expect(flags.locator('.badge-info')).toHaveText('INCOMPLETE');
  await expect(flags.locator('.badge-info')).toHaveAttribute('title', /recent posts/);
  await expect(flags).not.toContainText('NEVER POSTED');
  await expect(row.locator('.score-cell')).toHaveText('0');
});
