// packages/sqlite/src/ttl-cache.ts
// In-memory TTL cache for server-side deduplication across HTTP requests.
// Complements json-cache (persistent, file-based) with a lightweight
// in-memory cache that auto-expires and auto-prunes.

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

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
export class TTLCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private ttl: number;
  private maxSize: number;

  constructor(options: TTLCacheOptions = {}) {
    this.ttl = options.ttl ?? 30_000;
    this.maxSize = options.maxSize ?? 100;
  }

  /** Get a cached value if it exists and hasn't expired. */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Check if a non-expired entry exists for the given key. */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /** Store a value with the configured TTL. Auto-prunes if maxSize exceeded. */
  set(key: string, value: T): void {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttl
    });

    if (this.cache.size > this.maxSize) {
      this.prune();
    }
  }

  /** Remove a specific entry. */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of entries (including potentially expired ones). */
  get size(): number {
    return this.cache.size;
  }

  /** Remove all expired entries. */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }
}
