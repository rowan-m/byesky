// Cache to store followings, sync progress, and interaction history for each user.
// Keyed by user DID with browser-native IndexedDB persistence and in-memory test fallback.

const isBrowser = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

/**
 * Version of the shape of a cache entry. Bump it and add a step to `migrate()` when a change
 * can't be read by older code paths. v2 added `criteria.unknown`, `completedAt` and this field;
 * v1 entries are readable as-is.
 */
export const CACHE_SCHEMA_VERSION = 2;

/** Writes to IndexedDB are coalesced to at most one per entry in this window. */
const PERSIST_INTERVAL_MS = 1000;

function migrate(entry) {
  if (!entry || entry.schemaVersion === CACHE_SCHEMA_VERSION) return entry;
  return { ...entry, schemaVersion: CACHE_SCHEMA_VERSION };
}

export class UserSyncCache {
  constructor({ indexedDB: idb, localStorage: storage, persistIntervalMs } = {}) {
    this.store = new Map(); // In-memory fallback (used for Node environment and active browser sessions)
    this.dbName = 'ByeSkyCache';
    this.dbVersion = 1;
    this.storeName = 'user_sync';
    this.dbPromise = null;
    this.pendingWrites = new Map(); // did -> timer id for a scheduled IndexedDB write
    this.lastWriteAt = new Map(); // did -> time of the last IndexedDB write
    this.idb = idb ?? (isBrowser ? window.indexedDB : null);
    this.storage =
      storage ??
      (isBrowser && typeof window.localStorage !== 'undefined' ? window.localStorage : null);
    this.persistIntervalMs = persistIntervalMs ?? PERSIST_INTERVAL_MS;
    if (isBrowser && !idb) {
      // Write anything still pending when the tab is hidden or closed.
      window.addEventListener('pagehide', () => this.flushAll());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.flushAll();
      });
    }
  }

  // Opens the IndexedDB connection once and shares it between callers.
  _getDB() {
    if (!this.idb) return Promise.resolve(null);
    if (!this.dbPromise) {
      this.dbPromise = this._openDB().catch((err) => {
        this.dbPromise = null; // allow a later retry
        throw err;
      });
    }
    return this.dbPromise;
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const request = this.idb.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = (e) => resolve(e.target.result);

      request.onerror = (e) => {
        console.error('IndexedDB open error:', e.target.error);
        reject(e.target.error);
      };
    });
  }

  async get(did) {
    // Serve directly from warm in-memory cache if already loaded in this session
    if (this.store.has(did)) {
      return this.store.get(did);
    }

    // If not in browser (e.g. Node tests) or IndexedDB fails, use in-memory store
    if (!this.idb) {
      return this._getMemoryFallback(did);
    }

    try {
      const db = await this._getDB();
      return new Promise((resolve) => {
        const transaction = db.transaction(this.storeName, 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(did);

        request.onsuccess = () => {
          const data = migrate(request.result);
          if (data) {
            // Keep in-memory cache synchronized
            this.store.set(did, data);
            resolve(data);
          } else {
            resolve(this._getMemoryFallback(did));
          }
        };

        request.onerror = () => {
          resolve(this._getMemoryFallback(did));
        };
      });
    } catch (err) {
      console.warn('Fallback to in-memory cache due to IndexedDB get failure:', err);
      return this._getMemoryFallback(did);
    }
  }

  _loadLockedFromStorage(did) {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(`byesky_locked_${did}`);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (err) {
      console.warn('Failed to load locked DIDs from localStorage:', err);
    }
    return [];
  }

  _saveLockedToStorage(did, lockedDids) {
    if (!this.storage) return;
    try {
      this.storage.setItem(`byesky_locked_${did}`, JSON.stringify(lockedDids));
    } catch (err) {
      console.warn('Failed to save locked DIDs to localStorage:', err);
    }
  }

  _getMemoryFallback(did, preservedLockedDids = null) {
    if (!this.store.has(did)) {
      const initialLocked = preservedLockedDids ?? this._loadLockedFromStorage(did);
      this.store.set(did, {
        status: 'idle',
        error: null,
        progress: {
          total: 0,
          processed: 0,
          currentStage: 'Not started',
        },
        followings: [],
        lockedDids: initialLocked,
        interactions: {
          likedBy: [],
          repostedBy: [],
          repliedBy: [],
          messagedBy: [],
          userInteractedWith: [],
          userOutboundInteractions: [],
        },
        lastUpdated: null,
      });
    }
    return this.store.get(did);
  }

  async set(did, data) {
    const current = await this.get(did);
    const lockedDids =
      data.lockedDids !== undefined
        ? data.lockedDids
        : current.lockedDids || this._loadLockedFromStorage(did);
    if (data.lockedDids !== undefined) {
      this._saveLockedToStorage(did, lockedDids);
    }
    const updated = {
      ...current,
      ...data,
      lockedDids,
      schemaVersion: CACHE_SCHEMA_VERSION,
      lastUpdated: Date.now(),
    };
    this.store.set(did, updated);
    this._schedulePersist(did);
    return updated;
  }

  /**
   * Persists an entry to IndexedDB at most once per PERSIST_INTERVAL_MS. A sync updates
   * progress many times a second, and each write clones the whole follow list, so writes
   * are coalesced. The in-memory copy is always current; call flush() at milestones.
   */
  _schedulePersist(did) {
    if (!this.idb || this.pendingWrites.has(did)) return;
    const since = Date.now() - (this.lastWriteAt.get(did) ?? 0);
    const delay = Math.max(0, this.persistIntervalMs - since);
    const timer = setTimeout(() => {
      this.pendingWrites.delete(did);
      this._persist(did);
    }, delay);
    this.pendingWrites.set(did, timer);
  }

  async _persist(did) {
    const entry = this.store.get(did);
    if (!entry) return;
    this.lastWriteAt.set(did, Date.now());
    try {
      const db = await this._getDB();
      await new Promise((resolve) => {
        const request = db
          .transaction(this.storeName, 'readwrite')
          .objectStore(this.storeName)
          .put(entry, did);
        request.onsuccess = () => resolve();
        request.onerror = (e) => {
          console.error('IndexedDB set error:', e.target.error);
          resolve(); // keep the app working from memory
        };
      });
    } catch (err) {
      console.warn('Could not write cache to IndexedDB:', err);
    }
  }

  /**
   * Updates this tab's in-memory copy only. For UI-only state on an entry another tab owns,
   * so this tab never writes its stale copy back over the other tab's progress.
   */
  setLocal(did, data) {
    const current = this.store.get(did);
    if (current) this.store.set(did, { ...current, ...data });
  }

  /** Writes any pending change for this entry to IndexedDB now. */
  async flush(did) {
    const timer = this.pendingWrites.get(did);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingWrites.delete(did);
    await this._persist(did);
  }

  flushAll() {
    for (const did of [...this.pendingWrites.keys()]) this.flush(did);
  }

  /**
   * Re-reads an entry from IndexedDB, ignoring this tab's in-memory copy. Used to follow a
   * sync that another tab is running.
   */
  async reload(did) {
    if (!this.idb) return this.get(did);
    const db = await this._getDB();
    const data = await new Promise((resolve) => {
      const request = db
        .transaction(this.storeName, 'readonly')
        .objectStore(this.storeName)
        .get(did);
      request.onsuccess = () => resolve(migrate(request.result));
      request.onerror = () => resolve(null);
    });
    if (data) this.store.set(did, data);
    return data ?? this.get(did);
  }

  async getLockedDids(did) {
    const entry = await this.get(did);
    return entry.lockedDids || this._loadLockedFromStorage(did);
  }

  async setLockedDids(did, lockedDidsArray) {
    const cleanArray = Array.from(new Set(lockedDidsArray));
    return this.set(did, { lockedDids: cleanArray });
  }

  /**
   * Updates sync progress. `extraData.step` (`{ index, total, id, label }`) records which
   * phase of the sync is running; other `extraData` keys are merged into the cache entry.
   */
  async updateProgress(did, processed, total, stage, extraData = {}) {
    const current = await this.get(did);
    const { step, ...rest } = extraData;
    const progress = {
      total: total !== undefined ? total : current.progress.total,
      processed: processed !== undefined ? processed : current.progress.processed,
      currentStage: stage || current.progress.currentStage,
      step: step !== undefined ? step : current.progress.step,
    };
    return this.set(did, { ...rest, progress });
  }

  async clear(did) {
    const existingLocked = this.store.get(did)?.lockedDids || this._loadLockedFromStorage(did);
    clearTimeout(this.pendingWrites.get(did));
    this.pendingWrites.delete(did);
    this.store.delete(did);
    this._getMemoryFallback(did, existingLocked);
    if (!this.idb) return;

    try {
      const db = await this._getDB();
      return new Promise((resolve) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(did);

        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
      });
    } catch (err) {
      console.warn('Could not clear IndexedDB item:', err);
    }
  }
}

export const syncCache = new UserSyncCache();
