import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setWalModeWithRetry } from './wal-mode';
import { WriteMutexMap } from './write-mutex';

export type TenantDbConfig = {
  maxConnections?: number;
  idleTimeoutMs?: number;
  cleanupIntervalMs?: number;
  onOpen?: (db: Database, tenantId: string) => void;
  wrapDb?: (raw: Database, tenantId: string) => Database;
};

export type TenantDbManager = {
  getDb: (tenantId: string, dbPath: string) => Database;
  withWriteLock: <T>(tenantId: string, fn: () => T | Promise<T>) => Promise<T>;
  evict: (tenantId: string) => void;
  evictIdle: (maxIdleMs?: number) => number;
  closeAll: () => void;
  getStats: () => { activeConnections: number; oldestAccess: number | null };
};

type TenantConnection = {
  db: Database;
  lastAccessed: number;
};

const applyPragmas = (db: Database, dbPath: string): void => {
  if (dbPath !== ':memory:') {
    // busy_timeout first: correct for ordinary statement contention (see
    // wal-mode.ts for why the WAL switch itself needs its own retry).
    db.run('PRAGMA busy_timeout = 10000');
    setWalModeWithRetry(db);
  }
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA cache_size = -20000'); // 20MB
  db.run('PRAGMA temp_store = MEMORY');
  db.run('PRAGMA mmap_size = 268435456'); // 256MB
  db.run('PRAGMA foreign_keys = ON');
};

export const createTenantDbManager = (
  config?: TenantDbConfig
): TenantDbManager => {
  const maxConnections = config?.maxConnections ?? 200;
  const idleTimeoutMs = config?.idleTimeoutMs ?? 300_000;
  const cleanupIntervalMs = config?.cleanupIntervalMs ?? 60_000;

  const connections = new Map<string, TenantConnection>();
  const writeMutexes = new WriteMutexMap();
  let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

  const startCleanup = (): void => {
    if (cleanupIntervalId) return;
    cleanupIntervalId = setInterval(() => {
      evictIdle();
      for (const conn of connections.values()) {
        try {
          conn.db.run('PRAGMA wal_checkpoint(PASSIVE)');
          conn.db.run('PRAGMA optimize');
        } catch {
          // Non-critical
        }
      }
    }, cleanupIntervalMs);
    if (cleanupIntervalId.unref) {
      cleanupIntervalId.unref();
    }
  };

  // A tenant with an in-flight withWriteLock call must never be evicted:
  // closing its connection out from under a queued-or-running write breaks
  // the write mid-statement, and deleting its mutex hands the *next* caller
  // a brand-new WriteMutex - silently defeating serialization for that
  // tenant, since two callers now hold logically-independent locks over the
  // same underlying resource.
  const evict = (tenantId: string): void => {
    if (writeMutexes.isLocked(tenantId)) return;
    const entry = connections.get(tenantId);
    if (entry) {
      try {
        entry.db.close();
      } catch {
        // Ignore
      }
      connections.delete(tenantId);
      writeMutexes.delete(tenantId);
    }
  };

  const evictIdle = (maxIdleMs: number = idleTimeoutMs): number => {
    const now = Date.now();
    let evicted = 0;
    for (const [id, conn] of connections) {
      if (now - conn.lastAccessed > maxIdleMs) {
        if (writeMutexes.isLocked(id)) continue;
        try {
          conn.db.close();
        } catch {
          // Ignore
        }
        connections.delete(id);
        writeMutexes.delete(id);
        evicted++;
      }
    }
    return evicted;
  };

  const getDb = (tenantId: string, dbPath: string): Database => {
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
    } catch (err) {
      raw.close();
      throw err;
    }

    const db = config?.wrapDb ? config.wrapDb(raw, tenantId) : raw;

    connections.set(tenantId, { db, lastAccessed: Date.now() });

    if (connections.size > maxConnections) {
      // Pick the least-recently-used connection that isn't currently
      // write-locked - see the comment on evict() for why a locked tenant
      // must never be closed here. If every over-the-cap connection happens
      // to be locked, skip eviction this round rather than force-close one.
      let lruId: string | null = null;
      let lruAccessed = Number.MAX_SAFE_INTEGER;
      for (const [id, conn] of connections) {
        if (writeMutexes.isLocked(id)) continue;
        if (conn.lastAccessed < lruAccessed) {
          lruAccessed = conn.lastAccessed;
          lruId = id;
        }
      }
      if (lruId) {
        try {
          connections.get(lruId)?.db.close();
        } catch {
          // Ignore
        }
        connections.delete(lruId);
        writeMutexes.delete(lruId);
      }
    }

    startCleanup();
    return db;
  };

  const withWriteLock = <T>(
    tenantId: string,
    fn: () => T | Promise<T>
  ): Promise<T> => writeMutexes.withLock(tenantId, fn);

  const closeAll = (): void => {
    for (const [, conn] of connections) {
      try {
        conn.db.close();
      } catch {
        // Ignore
      }
    }
    connections.clear();
    if (cleanupIntervalId) {
      clearInterval(cleanupIntervalId);
      cleanupIntervalId = null;
    }
  };

  const getStats = (): {
    activeConnections: number;
    oldestAccess: number | null;
  } => {
    let oldestAccess: number | null = null;
    for (const conn of connections.values()) {
      if (oldestAccess === null || conn.lastAccessed < oldestAccess) {
        oldestAccess = conn.lastAccessed;
      }
    }
    return { activeConnections: connections.size, oldestAccess };
  };

  return { getDb, withWriteLock, evict, evictIdle, closeAll, getStats };
};
