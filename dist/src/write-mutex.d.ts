/**
 * A simple async mutex that serializes write access to a resource.
 * Bun is single-threaded, so this works as a plain promise queue —
 * no atomic operations needed.
 */
export declare class WriteMutex {
    private queue;
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
     * Get the number of tracked mutexes.
     */
    get size(): number;
}
//# sourceMappingURL=write-mutex.d.ts.map