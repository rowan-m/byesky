// Cache to store followings, sync progress, and interaction history for each user.
// Keyed by user DID with browser-native IndexedDB persistence and in-memory test fallback.

const isBrowser = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

class UserSyncCache {
  constructor() {
    this.store = new Map(); // In-memory fallback (used for Node environment and active browser sessions)
    this.dbName = 'ByeSkyCache';
    this.dbVersion = 1;
    this.storeName = 'user_sync';
    this.db = null;
  }

  // Helper to open / return IndexedDB connection in the browser
  async _getDB() {
    if (!isBrowser) return null;
    if (this.db) return this.db;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = (e) => {
        this.db = e.target.result;
        resolve(this.db);
      };

      request.onerror = (e) => {
        console.error('IndexedDB open error:', e.target.error);
        reject(e.target.error);
      };
    });
  }

  async get(did) {
    // If not in browser (e.g. Node tests) or IndexedDB fails, use in-memory store
    if (!isBrowser) {
      return this._getMemoryFallback(did);
    }

    try {
      const db = await this._getDB();
      return new Promise((resolve) => {
        const transaction = db.transaction(this.storeName, 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.get(did);

        request.onsuccess = () => {
          const data = request.result;
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

  _getMemoryFallback(did) {
    if (!this.store.has(did)) {
      this.store.set(did, {
        status: 'idle',
        error: null,
        progress: {
          total: 0,
          processed: 0,
          currentStage: 'Not started'
        },
        followings: [],
        interactions: {
          likedBy: [],
          repostedBy: [],
          repliedBy: [],
          messagedBy: [],
          userInteractedWith: [],
          userOutboundInteractions: []
        },
        lastUpdated: null
      });
    }
    return this.store.get(did);
  }

  async set(did, data) {
    const current = await this.get(did);
    const updated = { ...current, ...data, lastUpdated: Date.now() };
    this.store.set(did, updated);

    if (!isBrowser) {
      return updated;
    }

    try {
      const db = await this._getDB();
      return new Promise((resolve) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(updated, did);

        request.onsuccess = () => {
          resolve(updated);
        };

        request.onerror = (e) => {
          console.error('IndexedDB set error:', e.target.error);
          resolve(updated); // Resolve anyway to not break the app
        };
      });
    } catch (err) {
      console.warn('Could not write cache to IndexedDB:', err);
      return updated;
    }
  }

  async updateProgress(did, processed, total, stage) {
    const current = await this.get(did);
    current.progress = {
      total: total !== undefined ? total : current.progress.total,
      processed: processed !== undefined ? processed : current.progress.processed,
      currentStage: stage || current.progress.currentStage
    };
    current.lastUpdated = Date.now();
    await this.set(did, current);
  }

  async clear(did) {
    this.store.delete(did);
    if (!isBrowser) return;

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
