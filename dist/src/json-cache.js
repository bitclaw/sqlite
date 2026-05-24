// packages/sqlite/src/json-cache.ts
// levelsio-style JSON file caching for expensive queries
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
const isDevelopment = process.env.NODE_ENV === 'development';
const isCacheEntry = (data) => {
    return (data != null &&
        typeof data === 'object' &&
        'value' in data &&
        'metadata' in data &&
        typeof data.metadata?.createdTime === 'number');
};
/**
 * Simple, fast JSON file cache inspired by levelsio's approach
 * - Each cache key is a separate JSON file
 * - Atomic writes using temp files
 * - TTL-based expiration
 * - Stale-while-revalidate support
 * - No external dependencies
 */
export class JsonCache {
    cacheDir;
    defaultTtl;
    pendingWrites = new Map();
    constructor(config) {
        this.cacheDir = config.cacheDir;
        this.defaultTtl = config.defaultTtl ?? 300000; // 5 minutes default
    }
    /**
     * Initialize cache directory
     */
    async init() {
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
            if (isDevelopment) {
            }
        }
        catch (error) {
            console.error('[json-cache] Failed to initialize:', error);
            throw error;
        }
    }
    /**
     * Get cache file path for a key
     */
    getFilePath(key) {
        // Sanitize key for filesystem
        const sanitized = key.replace(/[^a-z0-9-_.]/gi, '_');
        return join(this.cacheDir, `${sanitized}.json`);
    }
    /**
     * Get value from cache
     */
    async get(key) {
        const filePath = this.getFilePath(key);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            const parsed = JSON.parse(data);
            if (!isCacheEntry(parsed)) {
                await this.delete(key);
                return null;
            }
            const entry = parsed;
            const now = Date.now();
            const age = now - entry.metadata.createdTime;
            // Check if expired
            if (entry.metadata.ttl && age > entry.metadata.ttl) {
                // Check stale-while-revalidate
                if (entry.metadata.swr &&
                    age <= entry.metadata.ttl + entry.metadata.swr) {
                    // Return stale value but trigger background revalidation
                    if (isDevelopment) {
                    }
                    return entry.value;
                }
                // Expired and past SWR window
                await this.delete(key);
                return null;
            }
            return entry.value;
        }
        catch (error) {
            if (error instanceof Error &&
                error.code === 'ENOENT') {
                // File doesn't exist - cache miss
                return null;
            }
            console.error(`[json-cache] Error reading ${key}:`, error);
            return null;
        }
    }
    /**
     * Set value in cache with atomic write
     */
    async set(key, value, options) {
        const filePath = this.getFilePath(key);
        // If there's already a pending write for this key, wait for it
        const pendingWrite = this.pendingWrites.get(key);
        if (pendingWrite) {
            await pendingWrite;
        }
        // Create new write promise
        const writePromise = this._atomicWrite(filePath, value, options);
        this.pendingWrites.set(key, writePromise);
        try {
            await writePromise;
        }
        finally {
            this.pendingWrites.delete(key);
        }
    }
    /**
     * Atomic write using temp file
     */
    async _atomicWrite(filePath, value, options) {
        const entry = {
            value,
            metadata: {
                createdTime: Date.now(),
                ttl: options?.ttl ?? this.defaultTtl,
                swr: options?.swr ?? null
            }
        };
        // Ensure directory exists
        const dir = dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        // Write to temp file first (atomic operation)
        const tempPath = `${filePath}.${randomBytes(8).toString('hex')}.tmp`;
        try {
            await fs.writeFile(tempPath, JSON.stringify(entry, null, isDevelopment ? 2 : 0), 'utf-8');
            // Atomic rename
            await fs.rename(tempPath, filePath);
            if (isDevelopment) {
            }
        }
        catch (error) {
            // Clean up temp file if it exists
            try {
                await fs.unlink(tempPath);
            }
            catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }
    /**
     * Delete cache entry
     */
    async delete(key) {
        const filePath = this.getFilePath(key);
        try {
            await fs.unlink(filePath);
            if (isDevelopment) {
            }
        }
        catch (error) {
            if (!(error instanceof Error) ||
                error.code !== 'ENOENT') {
                console.error(`[json-cache] Error deleting ${key}:`, error);
            }
        }
    }
    /**
     * Check if cache entry exists
     */
    async has(key) {
        const filePath = this.getFilePath(key);
        try {
            await fs.access(filePath);
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Clear all cache entries
     */
    async clear() {
        try {
            const files = await fs.readdir(this.cacheDir);
            await Promise.all(files
                .filter(file => file.endsWith('.json'))
                .map(file => fs.unlink(join(this.cacheDir, file))));
            if (isDevelopment) {
            }
        }
        catch (error) {
            console.error('[json-cache] Error clearing cache:', error);
        }
    }
    /**
     * Get cache statistics
     */
    async stats() {
        try {
            const files = await fs.readdir(this.cacheDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            return {
                size: jsonFiles.length,
                entries: jsonFiles.map(file => file.replace('.json', ''))
            };
        }
        catch {
            return { size: 0, entries: [] };
        }
    }
    /**
     * Clean up expired entries
     */
    async cleanup() {
        try {
            const files = await fs.readdir(this.cacheDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));
            let cleaned = 0;
            for (const file of jsonFiles) {
                const filePath = join(this.cacheDir, file);
                try {
                    const data = await fs.readFile(filePath, 'utf-8');
                    const parsed = JSON.parse(data);
                    if (!isCacheEntry(parsed)) {
                        await fs.unlink(filePath);
                        cleaned++;
                        continue;
                    }
                    const entry = parsed;
                    const now = Date.now();
                    const age = now - entry.metadata.createdTime;
                    // Check if expired (including SWR window)
                    const totalTtl = entry.metadata.ttl ?? this.defaultTtl;
                    const swrWindow = entry.metadata.swr ?? 0;
                    if (age > totalTtl + swrWindow) {
                        await fs.unlink(filePath);
                        cleaned++;
                    }
                }
                catch {
                    // If we can't read/parse the file, delete it
                    await fs.unlink(filePath);
                    cleaned++;
                }
            }
            if (isDevelopment && cleaned > 0) {
            }
            return cleaned;
        }
        catch (error) {
            console.error('[json-cache] Error during cleanup:', error);
            return 0;
        }
    }
}
/**
 * Factory function to create and initialize a JSON cache instance.
 * Awaits directory creation so the cache is ready to use immediately.
 */
export const createJsonCache = async (config) => {
    const cache = new JsonCache(config);
    await cache.init();
    // Set up periodic cleanup (every hour)
    if (process.env.NODE_ENV !== 'test') {
        setInterval(() => {
            cache.cleanup().catch(error => {
                console.error('[json-cache] Cleanup failed:', error);
            });
        }, 3600000); // 1 hour
    }
    return cache;
};
/**
 * Helper function for cachified pattern
 */
export const cachified = async (options) => {
    const { cache, key, getFreshValue, ttl, swr } = options;
    // Try to get from cache
    const cached = await cache.get(key);
    if (cached !== null) {
        return cached;
    }
    // Cache miss - get fresh value
    const freshValue = await getFreshValue();
    // Store in cache (don't await - fire and forget)
    cache.set(key, freshValue, { ttl, swr }).catch(error => {
        console.error(`[json-cache] Failed to cache ${key}:`, error);
    });
    return freshValue;
};
