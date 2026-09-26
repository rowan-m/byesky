import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RateLimiter,
  isNetworkError,
  isRetryableError,
  parseRateLimitHeaders,
  withRetry,
} from '../src/ratelimit.js';

/** Virtual clock: sleep() advances time instantly and records each wait. */
function fakeClock(start = 1_000_000) {
  const clock = {
    t: start,
    waits: [],
    now: () => clock.t,
    sleep: async (ms) => {
      clock.waits.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

function limiterWith(clock, opts) {
  return new RateLimiter({ now: clock.now, sleep: clock.sleep, ...opts });
}

function xrpcError(status, headers, message = 'err') {
  return Object.assign(new Error(message), { status, headers });
}

test('classifies retryable errors', () => {
  assert.equal(isRetryableError(xrpcError(429)), true);
  assert.equal(isRetryableError(xrpcError(502)), true);
  assert.equal(isRetryableError(xrpcError(1, undefined, 'Failed to fetch')), true);
  assert.equal(isRetryableError(new TypeError('Failed to fetch')), true);
  assert.equal(isRetryableError(xrpcError(400)), false);
  assert.equal(isRetryableError(xrpcError(401)), false);
  assert.equal(isRetryableError(Object.assign(new Error('x'), { name: 'AbortError' })), false);
  assert.equal(isNetworkError(xrpcError(500)), false);
});

test('parses rate-limit headers from objects and Headers', () => {
  assert.deepEqual(
    parseRateLimitHeaders({
      'RateLimit-Limit': '3000',
      'ratelimit-remaining': '12',
      'ratelimit-reset': '1700',
    }),
    { limit: 3000, remaining: 12, reset: 1_700_000 },
  );
  const h = new Headers({ 'ratelimit-remaining': '0' });
  assert.deepEqual(parseRateLimitHeaders(h), { limit: undefined, remaining: 0, reset: undefined });
  assert.deepEqual(parseRateLimitHeaders(undefined), {
    limit: undefined,
    remaining: undefined,
    reset: undefined,
  });
});

test('limiter spaces requests to the configured rate after the burst', async () => {
  const clock = fakeClock();
  const limiter = limiterWith(clock, { ratePerSecond: 4, burst: 2 });
  const start = clock.t;
  for (let i = 0; i < 6; i++) await limiter.acquire();
  // 2 immediate (burst), then 4 more at 250ms intervals.
  assert.equal(clock.t - start, 1000);
});

test('pauseUntil blocks every caller and is never shortened', async () => {
  const clock = fakeClock();
  const limiter = limiterWith(clock, { ratePerSecond: 100, burst: 5 });
  limiter.pauseUntil(clock.t + 5000);
  limiter.pauseUntil(clock.t + 1000);
  const start = clock.t;
  await limiter.acquire();
  assert.ok(clock.t - start >= 5000);
});

test('observe() pauses until reset when the window is nearly used up', () => {
  const clock = fakeClock(10_000_000);
  const limiter = limiterWith(clock, { ratePerSecond: 5 });
  const reset = String((clock.t + 30_000) / 1000);
  limiter.observe({
    'ratelimit-limit': '3000',
    'ratelimit-remaining': '2000',
    'ratelimit-reset': reset,
  });
  assert.equal(limiter.pauseRemaining(), 0);
  limiter.observe({
    'ratelimit-limit': '3000',
    'ratelimit-remaining': '100',
    'ratelimit-reset': reset,
  });
  assert.equal(limiter.pauseRemaining(), 30_000);
});

test('withRetry retries a 429 using the reset header and pauses the shared limiter', async () => {
  const clock = fakeClock(10_000_000);
  const limiter = limiterWith(clock, { ratePerSecond: 100, burst: 10 });
  const waits = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls === 1) {
        throw xrpcError(429, { 'ratelimit-reset': String((clock.t + 20_000) / 1000) });
      }
      return { data: 'ok' };
    },
    { limiter, onWait: (w) => waits.push(w), random: () => 0 },
  );
  assert.deepEqual(result, { data: 'ok' });
  assert.equal(calls, 2);
  assert.equal(waits[0].reason, 'rate-limit');
  assert.equal(waits[0].ms, 20_000);
});

test('withRetry treats "Failed to fetch" as a shared pause and retries', async () => {
  const clock = fakeClock();
  const limiter = limiterWith(clock, { ratePerSecond: 100, burst: 10 });
  let calls = 0;
  const waits = [];
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new TypeError('Failed to fetch');
      return {};
    },
    { limiter, onWait: (w) => waits.push(w), random: () => 1 },
  );
  assert.equal(calls, 3);
  assert.deepEqual(
    waits.map((w) => [w.reason, w.ms]),
    [
      ['network', 2000],
      ['network', 4000],
    ],
  );
});

test('withRetry gives up after maxAttempts and does not retry client errors', async () => {
  const clock = fakeClock();
  const limiter = limiterWith(clock, { ratePerSecond: 100, burst: 10 });

  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw xrpcError(503);
      },
      { limiter, maxAttempts: 3 },
    ),
    /err/,
  );
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        throw xrpcError(400, undefined, 'InvalidRequest');
      },
      { limiter },
    ),
    /InvalidRequest/,
  );
  assert.equal(calls, 1);
});

test('withRetry caps pauses from absurd reset headers', async () => {
  const clock = fakeClock(10_000_000);
  const limiter = limiterWith(clock, { ratePerSecond: 100, burst: 10 });
  const waits = [];
  let calls = 0;
  await withRetry(
    async () => {
      if (calls++ === 0) {
        throw xrpcError(429, { 'ratelimit-reset': String((clock.t + 86_400_000) / 1000) });
      }
      return {};
    },
    { limiter, onWait: (w) => waits.push(w) },
  );
  assert.equal(waits[0].ms, 5 * 60 * 1000);
});

test('acquire() rejects promptly when aborted', async () => {
  const limiter = new RateLimiter({ ratePerSecond: 1 });
  limiter.pauseUntil(Date.now() + 60_000);
  const controller = new AbortController();
  const pending = limiter.acquire(controller.signal);
  controller.abort();
  await assert.rejects(pending, (err) => err.name === 'AbortError');
});
