export type TTLCacheOptions = {
    /** Time-to-live in milliseconds. Default: 30_000 (30s). */
    ttl?: number;
    /** Maximum entries before auto-pruning expired items. Default: 100. */
    maxSize?: number;
};
/**
 * In-memory TTL cache backed by a Map.
 *
 * Designed for server-side deduplication of expensive lookups (auth sessions,
 * membership checks, bootstrap data) across HTTP requests. Entries expire
 * after `ttl` milliseconds and are automatically pruned when the map exceeds
 * `maxSize`.
 *
 * Unlike WeakMap per-request caching (which deduplicates within a single
 * request), TTLCache deduplicates across requests — e.g. when TanStack
 * Router replays `beforeLoad` on client hydration, the server returns the
 * cached result instantly (0 DB queries).
 *
 * @example
 * ```typescript
 * import { TTLCache } from '@bitclaw/sqlite/ttl-cache';
 *
 * type BootstrapData = { user: User; workspaces: Workspace[] };
 *
 * const bootstrapCache = new TTLCache<BootstrapData>({ ttl: 30_000 });
 *
 * // In your server function:
 * const cached = bootstrapCache.get(sessionId);
 * if (cached) return cached;
 *
 * const data = await expensiveQuery();
 * bootstrapCache.set(sessionId, data);
 * return data;
 * ```
 */
export declare class TTLCache<T> {
    private cache;
    private ttl;
    private maxSize;
    constructor(options?: TTLCacheOptions);
    /** Get a cached value if it exists and hasn't expired. */
    get(key: string): T | undefined;
    /** Check if a non-expired entry exists for the given key. */
    has(key: string): boolean;
    /** Store a value with the configured TTL. Auto-prunes if maxSize exceeded. */
    set(key: string, value: T): void;
    /** Remove a specific entry. */
    delete(key: string): boolean;
    /** Remove all entries. */
    clear(): void;
    /** Number of entries (including potentially expired ones). */
    get size(): number;
    /** Remove all expired entries. */
    prune(): number;
}
//# sourceMappingURL=ttl-cache.d.ts.map