export type CacheEntry<T> = {
    value: T;
    metadata: {
        createdTime: number;
        ttl: number | null;
        swr?: number | null;
    };
};
export type CacheOptions = {
    ttl?: number;
    swr?: number;
};
export type JsonCacheConfig = {
    cacheDir: string;
    defaultTtl?: number;
};
/**
 * Simple, fast JSON file cache inspired by levelsio's approach
 * - Each cache key is a separate JSON file
 * - Atomic writes using temp files
 * - TTL-based expiration
 * - Stale-while-revalidate support
 * - No external dependencies
 */
export declare class JsonCache {
    private cacheDir;
    private defaultTtl;
    private pendingWrites;
    constructor(config: JsonCacheConfig);
    /**
     * Initialize cache directory
     */
    init(): Promise<void>;
    /**
     * Get cache file path for a key
     */
    private getFilePath;
    /**
     * Get value from cache
     */
    get<T = unknown>(key: string): Promise<T | null>;
    /**
     * Set value in cache with atomic write
     */
    set<T = unknown>(key: string, value: T, options?: CacheOptions): Promise<void>;
    /**
     * Atomic write using temp file
     */
    private _atomicWrite;
    /**
     * Delete cache entry
     */
    delete(key: string): Promise<void>;
    /**
     * Check if cache entry exists
     */
    has(key: string): Promise<boolean>;
    /**
     * Clear all cache entries
     */
    clear(): Promise<void>;
    /**
     * Get cache statistics
     */
    stats(): Promise<{
        size: number;
        entries: string[];
    }>;
    /**
     * Clean up expired entries
     */
    cleanup(): Promise<number>;
}
/**
 * Factory function to create and initialize a JSON cache instance.
 * Awaits directory creation so the cache is ready to use immediately.
 */
export declare const createJsonCache: (config: JsonCacheConfig) => Promise<JsonCache>;
/**
 * Helper function for cachified pattern
 */
export declare const cachified: <T>(options: {
    cache: JsonCache;
    key: string;
    getFreshValue: () => Promise<T>;
    ttl?: number;
    swr?: number;
}) => Promise<T>;
//# sourceMappingURL=json-cache.d.ts.map