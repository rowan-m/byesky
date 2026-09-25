// Client-side request pacing for the analysis sync.
//
// A sync touches one or two API calls per followed account, so without pacing a large
// follow list quickly exhausts the per-IP rate limits of the user's PDS and the public
// AppView. Those limits are shared with every other Bluesky client on the same network,
// so blowing through them can break the user's other Bluesky sessions too. Every sync
// request therefore goes through a shared limiter per host, and retryable failures back
// off and pause that host for everyone rather than per worker.

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** HTTP statuses worth retrying: rate limiting and transient server/upstream failures. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * True for network-level failures. Browsers report a rate-limited response that lacks CORS
 * headers as a generic network error ("Failed to fetch"), and the XRPC client surfaces
 * those with status 1 (ResponseType.Unknown).
 */
export function isNetworkError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err.status === 1) return true;
  if (err instanceof TypeError) return true;
  return /failed to fetch|networkerror|load failed|network request failed/i.test(err.message || '');
}

export function isRateLimitError(err) {
  return err?.status === 429;
}

export function isRetryableError(err) {
  if (!err || err.name === 'AbortError') return false;
  return RETRYABLE_STATUSES.has(err.status) || isNetworkError(err);
}

/** Case-insensitive header lookup that works for plain objects and Headers instances. */
function readHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * Parses the standard `ratelimit-*` response headers. `reset` is returned as a millisecond
 * timestamp. Headers may be missing (or hidden by CORS), in which case fields are undefined.
 */
export function parseRateLimitHeaders(headers) {
  const num = (name) => {
    const raw = readHeader(headers, name);
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const limit = num('ratelimit-limit');
  const remaining = num('ratelimit-remaining');
  const resetSeconds = num('ratelimit-reset');
  return {
    limit,
    remaining,
    reset: resetSeconds === undefined ? undefined : resetSeconds * 1000,
  };
}

/**
 * Token-bucket limiter shared by all requests to one host. `acquire()` resolves when the
 * caller may send a request. `pauseUntil()` blocks every caller, e.g. after a 429.
 */
export class RateLimiter {
  constructor({
    name,
    ratePerSecond,
    burst = 1,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = {}) {
    if (typeof ratePerSecond !== 'number' || ratePerSecond <= 0)
      throw new Error('ratePerSecond must be positive');
    this.name = name || 'api';
    this.intervalMs = 1000 / ratePerSecond;
    this.burst = Math.max(1, burst);
    this.tokens = this.burst;
    this.now = now;
    this.sleep = sleep;
    this.lastRefill = now();
    this.pausedUntil = 0;
  }

  refill() {
    const current = this.now();
    const elapsed = current - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed / this.intervalMs);
      this.lastRefill = current;
    }
  }

  /** Blocks every caller until `timestamp` (ms). Never shortens an existing pause. */
  pauseUntil(timestamp) {
    if (timestamp > this.pausedUntil) this.pausedUntil = timestamp;
  }

  /** Milliseconds left on the current pause, or 0. */
  pauseRemaining() {
    return Math.max(0, this.pausedUntil - this.now());
  }

  async acquire(signal) {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const paused = this.pauseRemaining();
      if (paused > 0) {
        await this.sleep(paused, signal);
        continue;
      }
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) * this.intervalMs), signal);
    }
  }

  /**
   * Uses rate-limit headers from a successful response to slow down before the server has
   * to refuse us: once less than 10% of the window is left, pause until it resets.
   */
  observe(headers) {
    const { limit, remaining, reset } = parseRateLimitHeaders(headers);
    if (remaining === undefined || reset === undefined) return;
    const threshold = limit ? Math.max(5, Math.ceil(limit * 0.1)) : 5;
    if (remaining <= threshold) this.pauseUntil(Math.min(reset, this.now() + MAX_PAUSE_MS));
  }
}

/** Longest single pause, so a bogus reset header can't stall the sync indefinitely. */
export const MAX_PAUSE_MS = 5 * 60 * 1000;

/**
 * Runs `fn` through `limiter`, retrying rate-limit, transient server and network errors with
 * exponential backoff and jitter. A rate-limit (or network) failure pauses the whole limiter,
 * so all concurrent workers back off together. Non-retryable errors are thrown immediately;
 * retryable ones are thrown once `maxAttempts` is reached.
 *
 * `onWait({ ms, reason, attempt })` is called before each backoff so the UI can explain it.
 */
export async function withRetry(
  fn,
  {
    limiter,
    signal,
    maxAttempts = 6,
    baseDelayMs = 2000,
    maxDelayMs = 60000,
    onWait,
    random = Math.random,
  } = {},
) {
  const now = limiter?.now ?? (() => Date.now());
  const sleep = limiter?.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt++) {
    if (limiter) await limiter.acquire(signal);
    else if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');

    try {
      const result = await fn();
      if (limiter && result && result.headers) limiter.observe(result.headers);
      return result;
    } catch (err) {
      if (signal?.aborted) throw signal.reason ?? err;
      if (!isRetryableError(err) || attempt >= maxAttempts) throw err;

      // Exponential backoff with full jitter on the upper half: 2s, 4s, 8s… capped.
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      let delay = Math.round(exp / 2 + random() * (exp / 2));
      let reason = 'error';

      if (isRateLimitError(err)) {
        reason = 'rate-limit';
        const { reset } = parseRateLimitHeaders(err.headers);
        if (reset !== undefined) delay = Math.max(delay, reset - now());
      } else if (isNetworkError(err)) {
        // Most likely a rate-limited response hidden by CORS, so treat it the same way.
        reason = 'network';
      }
      delay = Math.min(delay, MAX_PAUSE_MS);

      if (limiter && reason !== 'error') {
        limiter.pauseUntil(now() + delay);
        if (onWait) onWait({ ms: delay, reason, attempt });
        continue; // acquire() waits out the shared pause
      }

      if (onWait) onWait({ ms: delay, reason, attempt });
      await sleep(delay, signal);
    }
  }
}

/**
 * Rates used for a sync. The PDS is shared with the user's other Bluesky apps, so it gets a
 * conservative budget (about a third of a typical 3,000 requests / 5 minutes per-IP limit).
 */
export const SYNC_RATES = {
  pds: { ratePerSecond: 3, burst: 3 },
  appview: { ratePerSecond: 6, burst: 4 },
};

export function createSyncLimiters(overrides = {}) {
  return {
    pds: new RateLimiter({ name: 'pds', ...SYNC_RATES.pds, ...overrides.pds }),
    appview: new RateLimiter({ name: 'appview', ...SYNC_RATES.appview, ...overrides.appview }),
  };
}
