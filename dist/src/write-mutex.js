// packages/sqlite/src/write-mutex.ts
// Promise-based per-resource write mutex for SQLite concurrency
/**
 * A simple async mutex that serializes write access to a resource.
 * Bun is single-threaded, so this works as a plain promise queue -
 * no atomic operations needed.
 */
export class WriteMutex {
    queue = Promise.resolve();
    active = 0;
    /**
     * True while at least one caller is queued on or executing inside
     * acquire(). Callers that close/evict the underlying resource this mutex
     * guards must check this first - closing out from under a queued-or-running
     * acquire() defeats the serialization guarantee entirely.
     */
    get locked() {
        return this.active > 0;
    }
    /**
     * Acquire the mutex, execute the function, then release.
     * Only one function runs at a time per mutex instance.
     */
    async acquire(fn) {
        this.active++;
        let release;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        // Chain onto the queue so we wait for prior operations
        const prior = this.queue;
        this.queue = gate;
        try {
            await prior;
            return await fn();
        }
        finally {
            release();
            this.active--;
        }
    }
}
/**
 * A map of named mutexes for per-resource write serialization.
 * Useful for per-workspace or per-database write locking.
 */
export class WriteMutexMap {
    mutexes = new Map();
    /**
     * Acquire the mutex for a given key, execute the function, then release.
     */
    async withLock(key, fn) {
        let mutex = this.mutexes.get(key);
        if (!mutex) {
            mutex = new WriteMutex();
            this.mutexes.set(key, mutex);
        }
        return mutex.acquire(fn);
    }
    /**
     * Remove a mutex for a key (e.g., when evicting a connection).
     */
    delete(key) {
        this.mutexes.delete(key);
    }
    /**
     * True if the mutex for this key currently has a caller queued on or
     * executing inside acquire(). A key with no mutex yet is never locked.
     */
    isLocked(key) {
        return this.mutexes.get(key)?.locked ?? false;
    }
    /**
     * Get the number of tracked mutexes.
     */
    get size() {
        return this.mutexes.size;
    }
}
