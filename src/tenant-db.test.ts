import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTenantDbManager } from './tenant-db';

const TEST_DIR = path.join(os.tmpdir(), 'tenant-db-test', String(Date.now()));

const makeTenantPath = (id: string) => path.join(TEST_DIR, id, 'data.db');

beforeEach(() => {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterEach(() => {
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
});

describe('createTenantDbManager', () => {
  describe('getDb', () => {
    test('returns Database for new tenant and creates file + dir', () => {
      const manager = createTenantDbManager();
      const dbPath = makeTenantPath('t1');
      const db = manager.getDb('t1', dbPath);
      expect(db).toBeInstanceOf(Database);
      expect(existsSync(dbPath)).toBe(true);
      manager.closeAll();
    });

    test('returns same cached instance on second call', () => {
      const manager = createTenantDbManager();
      const dbPath = makeTenantPath('t1');
      const db1 = manager.getDb('t1', dbPath);
      const db2 = manager.getDb('t1', dbPath);
      expect(db1).toBe(db2);
      manager.closeAll();
    });

    test('calls onOpen exactly once per tenant', () => {
      let callCount = 0;
      const manager = createTenantDbManager({
        onOpen: () => {
          callCount++;
        }
      });
      const dbPath = makeTenantPath('t1');
      manager.getDb('t1', dbPath);
      manager.getDb('t1', dbPath); // cache hit — no second call
      expect(callCount).toBe(1);
      manager.closeAll();
    });

    test('applies wrapDb to the Database', () => {
      let wrapped = false;
      const manager = createTenantDbManager({
        wrapDb: (raw, _id) => {
          wrapped = true;
          return raw;
        }
      });
      manager.getDb('t1', makeTenantPath('t1'));
      expect(wrapped).toBe(true);
      manager.closeAll();
    });

    test('applies default PRAGMAs', () => {
      const manager = createTenantDbManager();
      const db = manager.getDb('t1', makeTenantPath('t1'));
      const journalMode = (
        db.query('PRAGMA journal_mode').get() as { journal_mode: string }
      ).journal_mode;
      const sync = (
        db.query('PRAGMA synchronous').get() as { synchronous: number }
      ).synchronous;
      const cacheSize = (
        db.query('PRAGMA cache_size').get() as { cache_size: number }
      ).cache_size;
      const mmapSize = (
        db.query('PRAGMA mmap_size').get() as { mmap_size: number }
      ).mmap_size;
      const busyTimeout = (
        db.query('PRAGMA busy_timeout').get() as { timeout: number }
      ).timeout;
      expect(journalMode).toBe('wal');
      expect(sync).toBe(1); // NORMAL = 1
      expect(cacheSize).toBe(-20000);
      expect(mmapSize).toBe(268435456);
      expect(busyTimeout).toBe(10000);
      manager.closeAll();
    });

    test('allows onOpen to override PRAGMAs', () => {
      const manager = createTenantDbManager({
        onOpen: db => {
          db.run('PRAGMA wal_autocheckpoint = 0');
        }
      });
      const db = manager.getDb('t1', makeTenantPath('t1'));
      const val = (
        db.query('PRAGMA wal_autocheckpoint').get() as {
          wal_autocheckpoint: number;
        }
      ).wal_autocheckpoint;
      expect(val).toBe(0);
      manager.closeAll();
    });

    test('evicts LRU connection when size exceeds maxConnections', () => {
      const manager = createTenantDbManager({ maxConnections: 2 });
      manager.getDb('t1', makeTenantPath('t1'));
      manager.getDb('t2', makeTenantPath('t2'));
      manager.getDb('t3', makeTenantPath('t3')); // evicts t1 (LRU)
      expect(manager.getStats().activeConnections).toBe(2);
      manager.closeAll();
    });

    test('does not evict the LRU connection if it has an in-flight write lock', async () => {
      // maxConnections: 1, and t1 is the only (therefore always-LRU)
      // connection - it would normally be evicted the moment a second
      // tenant is opened. With its write lock held, eviction must pick a
      // different (unlocked) victim instead - here, the newly-opened t2 -
      // rather than close t1 out from under its in-flight write.
      let openCount = 0;
      const manager = createTenantDbManager({
        maxConnections: 1,
        onOpen: (_db, tenantId) => {
          if (tenantId === 't1') openCount++;
        }
      });
      manager.getDb('t1', makeTenantPath('t1'));
      expect(openCount).toBe(1);

      let resolveHold: () => void;
      const hold = new Promise<void>(resolve => {
        resolveHold = resolve;
      });
      const writeDone = manager.withWriteLock('t1', async () => {
        await hold;
      });

      manager.getDb('t2', makeTenantPath('t2'));
      expect(manager.getStats().activeConnections).toBe(1);
      // t1 must still be the live connection - if it had been evicted and
      // reopened, onOpen would have fired again.
      expect(openCount).toBe(1);

      resolveHold!();
      await writeDone;
      manager.closeAll();
    });

    test('closes raw DB and rethrows when onOpen throws', () => {
      const manager = createTenantDbManager({
        onOpen: () => {
          throw new Error('migration failed');
        }
      });
      expect(() => manager.getDb('t1', makeTenantPath('t1'))).toThrow(
        'migration failed'
      );
      // No connection should be cached
      expect(manager.getStats().activeConnections).toBe(0);
    });
  });

  describe('withWriteLock', () => {
    test('serializes concurrent writes for same tenantId', async () => {
      const manager = createTenantDbManager();
      const db = manager.getDb('t1', makeTenantPath('t1'));
      db.run('CREATE TABLE counter (n INTEGER)');
      db.run('INSERT INTO counter VALUES (0)');

      const results: number[] = [];
      const increment = () =>
        manager.withWriteLock('t1', () => {
          const row = db
            .query<{ n: number }, []>('SELECT n FROM counter')
            .get()!;
          const next = row.n + 1;
          db.run('UPDATE counter SET n = ?', [next]);
          results.push(next);
          return next;
        });

      await Promise.all([increment(), increment(), increment()]);
      expect(results).toEqual([1, 2, 3]);
      manager.closeAll();
    });

    test('allows concurrent writes for different tenantIds', async () => {
      const manager = createTenantDbManager();
      const times: string[] = [];
      const write = (id: string) =>
        manager.withWriteLock(id, async () => {
          times.push(`start:${id}`);
          await new Promise(r => setTimeout(r, 10));
          times.push(`end:${id}`);
        });

      await Promise.all([write('t1'), write('t2')]);
      // Both start before either ends (truly concurrent)
      expect(times[0]).toContain('start');
      expect(times[1]).toContain('start');
      manager.closeAll();
    });
  });

  describe('evict', () => {
    test('closes connection and removes from cache', () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));
      expect(manager.getStats().activeConnections).toBe(1);
      manager.evict('t1');
      expect(manager.getStats().activeConnections).toBe(0);
    });

    test('is a no-op for unknown tenantId', () => {
      const manager = createTenantDbManager();
      expect(() => manager.evict('nonexistent')).not.toThrow();
    });

    test('is a no-op while a write lock is in flight for that tenantId', async () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));

      let resolveHold: () => void;
      const hold = new Promise<void>(resolve => {
        resolveHold = resolve;
      });
      const writeDone = manager.withWriteLock('t1', async () => {
        await hold;
      });

      manager.evict('t1');
      expect(manager.getStats().activeConnections).toBe(1);

      resolveHold!();
      await writeDone;
      manager.closeAll();
    });
  });

  describe('evictIdle', () => {
    test('evicts connections idle longer than maxIdleMs', async () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));
      await new Promise(r => setTimeout(r, 20));
      const evicted = manager.evictIdle(10); // 10ms threshold
      expect(evicted).toBe(1);
      expect(manager.getStats().activeConnections).toBe(0);
    });

    test('keeps connections accessed within maxIdleMs', () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));
      const evicted = manager.evictIdle(60_000); // 60s threshold
      expect(evicted).toBe(0);
      expect(manager.getStats().activeConnections).toBe(1);
      manager.closeAll();
    });

    test('returns evicted count', async () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));
      manager.getDb('t2', makeTenantPath('t2'));
      await new Promise(r => setTimeout(r, 20));
      const evicted = manager.evictIdle(10);
      expect(evicted).toBe(2);
    });

    test('does not evict a connection with an in-flight write lock', async () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));

      let resolveHold: () => void;
      const hold = new Promise<void>(resolve => {
        resolveHold = resolve;
      });
      const writeDone = manager.withWriteLock('t1', async () => {
        await hold;
      });

      await new Promise(r => setTimeout(r, 20));
      const evicted = manager.evictIdle(10);
      expect(evicted).toBe(0);
      expect(manager.getStats().activeConnections).toBe(1);

      resolveHold!();
      await writeDone;
      manager.closeAll();
    });
  });

  describe('closeAll', () => {
    test('closes all connections and clears cache', () => {
      const manager = createTenantDbManager();
      manager.getDb('t1', makeTenantPath('t1'));
      manager.getDb('t2', makeTenantPath('t2'));
      manager.closeAll();
      expect(manager.getStats().activeConnections).toBe(0);
    });
  });

  describe('getStats', () => {
    test('returns correct activeConnections count', () => {
      const manager = createTenantDbManager();
      expect(manager.getStats().activeConnections).toBe(0);
      manager.getDb('t1', makeTenantPath('t1'));
      expect(manager.getStats().activeConnections).toBe(1);
      manager.getDb('t2', makeTenantPath('t2'));
      expect(manager.getStats().activeConnections).toBe(2);
      manager.closeAll();
    });

    test('returns null oldestAccess when empty', () => {
      const manager = createTenantDbManager();
      expect(manager.getStats().oldestAccess).toBeNull();
    });

    test('returns oldest lastAccessed timestamp', () => {
      const manager = createTenantDbManager();
      const before = Date.now();
      manager.getDb('t1', makeTenantPath('t1'));
      const after = Date.now();
      const stats = manager.getStats();
      expect(stats.oldestAccess).toBeGreaterThanOrEqual(before);
      expect(stats.oldestAccess).toBeLessThanOrEqual(after);
      manager.closeAll();
    });
  });
});
