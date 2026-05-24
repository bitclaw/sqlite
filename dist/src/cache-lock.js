// packages/sqlite/src/cache-lock.ts
// DB-backed distributed locks for mutual exclusion using bun:sqlite
import { randomUUID } from 'node:crypto';
export class CacheLock {
    db;
    acquireStmt;
    checkOwnerStmt;
    releaseStmt;
    forceReleaseStmt;
    refreshStmt;
    isLockedStmt;
    pruneExpiredStmt;
    deleteExpiredStmt;
    constructor(db) {
        this.db = db;
        db.run(`
      CREATE TABLE IF NOT EXISTS cache_locks (
        key TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        expiration INTEGER NOT NULL
      )
    `);
        db.run(`
      CREATE INDEX IF NOT EXISTS idx_cache_locks_expiration
        ON cache_locks (expiration)
    `);
        this.deleteExpiredStmt = db.query('DELETE FROM cache_locks WHERE key = $key AND expiration <= $now');
        this.acquireStmt = db.query('INSERT OR IGNORE INTO cache_locks (key, owner, expiration) VALUES ($key, $owner, $expiration)');
        this.checkOwnerStmt = db.query('SELECT owner FROM cache_locks WHERE key = $key');
        this.releaseStmt = db.query('DELETE FROM cache_locks WHERE key = $key AND owner = $owner');
        this.forceReleaseStmt = db.query('DELETE FROM cache_locks WHERE key = $key');
        this.refreshStmt = db.query('UPDATE cache_locks SET expiration = $expiration WHERE key = $key AND owner = $owner');
        this.isLockedStmt = db.query('SELECT 1 FROM cache_locks WHERE key = $key AND expiration > $now LIMIT 1');
        this.pruneExpiredStmt = db.query('DELETE FROM cache_locks WHERE expiration <= $now');
    }
    acquire(key, ttlMs, owner) {
        const actualOwner = owner ?? randomUUID();
        const now = Date.now();
        const expiration = now + ttlMs;
        const result = this.db.transaction(() => {
            // Remove expired lock for this key first
            this.deleteExpiredStmt.run({ $key: key, $now: now });
            // Try to insert — OR IGNORE means it fails silently if key exists
            this.acquireStmt.run({
                $key: key,
                $owner: actualOwner,
                $expiration: expiration
            });
            // Check who owns the lock
            const row = this.checkOwnerStmt.get({ $key: key });
            if (row && row.owner === actualOwner) {
                return { acquired: true, owner: actualOwner };
            }
            return { acquired: false, owner: row?.owner ?? '' };
        });
        return result.immediate();
    }
    release(key, owner) {
        const result = this.releaseStmt.run({ $key: key, $owner: owner });
        return result.changes > 0;
    }
    forceRelease(key) {
        const result = this.forceReleaseStmt.run({ $key: key });
        return result.changes > 0;
    }
    refresh(key, ttlMs, owner) {
        const expiration = Date.now() + ttlMs;
        const result = this.refreshStmt.run({
            $key: key,
            $owner: owner,
            $expiration: expiration
        });
        return result.changes > 0;
    }
    isLocked(key) {
        const row = this.isLockedStmt.get({ $key: key, $now: Date.now() });
        return row != null;
    }
    pruneExpired() {
        const result = this.pruneExpiredStmt.run({ $now: Date.now() });
        return result.changes;
    }
    async withLock(key, ttlMs, fn) {
        const result = this.acquire(key, ttlMs);
        if (!result.acquired) {
            throw new Error(`Failed to acquire lock: ${key}`);
        }
        try {
            return await fn();
        }
        finally {
            this.release(key, result.owner);
        }
    }
}
