/**
 * A simple async mutex that serializes write access to a resource.
 * Bun is single-threaded, so this works as a plain promise queue -
 * no atomic operations needed.
 */
export declare class WriteMutex {
    private queue;
    private active;
    /**
     * True while at least one caller is queued on or executing inside
     * acquire(). Callers that close/evict the underlying resource this mutex
     * guards must check this first - closing out from under a queued-or-running
     * acquire() defeats the serialization guarantee entirely.
     */
    get locked(): boolean;
    /**
     * Acquire the mutex, execute the function, then release.
     * Only one function runs at a time per mutex instance.
     */
    acquire<T>(fn: () => T | Promise<T>): Promise<T>;
}
/**
 * A map of named mutexes for per-resource write serialization.
 * Useful for per-workspace or per-database write locking.
 */
export declare class WriteMutexMap {
    private mutexes;
    /**
     * Acquire the mutex for a given key, execute the function, then release.
     */
    withLock<T>(key: string, fn: () => T | Promise<T>): Promise<T>;
    /**
     * Remove a mutex for a key (e.g., when evicting a connection).
     */
    delete(key: string): void;
    /**
     * True if the mutex for this key currently has a caller queued on or
     * executing inside acquire(). A key with no mutex yet is never locked.
     */
    isLocked(key: string): boolean;
    /**
     * Get the number of tracked mutexes.
     */
    get size(): number;
}
//# sourceMappingURL=write-mutex.d.ts.map