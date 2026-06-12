import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WriteMutexMap } from './write-mutex';
const applyPragmas = (db, dbPath) => {
    if (dbPath !== ':memory:') {
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA busy_timeout = 10000');
    }
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA cache_size = -20000'); // 20MB
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA mmap_size = 268435456'); // 256MB
    db.run('PRAGMA foreign_keys = ON');
};
export const createTenantDbManager = (config) => {
    const maxConnections = config?.maxConnections ?? 200;
    const idleTimeoutMs = config?.idleTimeoutMs ?? 300_000;
    const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;
    const connections = new Map();
    const writeMutexes = new WriteMutexMap();
    let cleanupIntervalId = null;
    const startCleanup = () => {
        if (cleanupIntervalId)
            return;
        cleanupIntervalId = setInterval(() => {
            evictIdle();
            for (const conn of connections.values()) {
                try {
                    conn.db.run('PRAGMA wal_checkpoint(PASSIVE)');
                    conn.db.run('PRAGMA optimize');
                }
                catch {
                    // Non-critical
                }
            }
        }, cleanupIntervalMs);
        if (cleanupIntervalId.unref) {
            cleanupIntervalId.unref();
        }
    };
    const evict = (tenantId) => {
        const entry = connections.get(tenantId);
        if (entry) {
            try {
                entry.db.close();
            }
            catch {
                // Ignore
            }
            connections.delete(tenantId);
            writeMutexes.delete(tenantId);
        }
    };
    const evictIdle = (maxIdleMs = idleTimeoutMs) => {
        const now = Date.now();
        let evicted = 0;
        for (const [id, conn] of connections) {
            if (now - conn.lastAccessed > maxIdleMs) {
                try {
                    conn.db.close();
                }
                catch {
                    // Ignore
                }
                connections.delete(id);
                writeMutexes.delete(id);
                evicted++;
            }
        }
        return evicted;
    };
    const getDb = (tenantId, dbPath) => {
        const cached = connections.get(tenantId);
        if (cached) {
            cached.lastAccessed = Date.now();
            return cached.db;
        }
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const raw = new Database(dbPath);
        applyPragmas(raw, dbPath);
        try {
            config?.onOpen?.(raw, tenantId);
        }
        catch (err) {
            raw.close();
            throw err;
        }
        const db = config?.wrapDb ? config.wrapDb(raw, tenantId) : raw;
        connections.set(tenantId, { db, lastAccessed: Date.now() });
        if (connections.size > maxConnections) {
            let lruId = null;
            let lruAccessed = Number.MAX_SAFE_INTEGER;
            for (const [id, conn] of connections) {
                if (conn.lastAccessed < lruAccessed) {
                    lruAccessed = conn.lastAccessed;
                    lruId = id;
                }
            }
            if (lruId) {
                try {
                    connections.get(lruId)?.db.close();
                }
                catch {
                    // Ignore
                }
                connections.delete(lruId);
                writeMutexes.delete(lruId);
            }
        }
        startCleanup();
        return db;
    };
    const withWriteLock = (tenantId, fn) => writeMutexes.withLock(tenantId, fn);
    const closeAll = () => {
        for (const [, conn] of connections) {
            try {
                conn.db.close();
            }
            catch {
                // Ignore
            }
        }
        connections.clear();
        if (cleanupIntervalId) {
            clearInterval(cleanupIntervalId);
            cleanupIntervalId = null;
        }
    };
    const getStats = () => {
        let oldestAccess = null;
        for (const conn of connections.values()) {
            if (oldestAccess === null || conn.lastAccessed < oldestAccess) {
                oldestAccess = conn.lastAccessed;
            }
        }
        return { activeConnections: connections.size, oldestAccess };
    };
    return { getDb, withWriteLock, evict, evictIdle, closeAll, getStats };
};
