import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CacheLock } from './cache-lock';

describe('CacheLock', () => {
  let db: Database;
  let lock: CacheLock;

  beforeEach(() => {
    db = new Database(':memory:');
    lock = new CacheLock(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('acquire', () => {
    test('acquires a lock and returns owner', () => {
      const result = lock.acquire('my-lock', 5000);
      expect(result.acquired).toBe(true);
      expect(result.owner).toBeTruthy();
    });

    test('uses provided owner', () => {
      const result = lock.acquire('my-lock', 5000, 'worker-1');
      expect(result.acquired).toBe(true);
      expect(result.owner).toBe('worker-1');
    });

    test('rejects second acquire with different owner', () => {
      const first = lock.acquire('my-lock', 5000, 'worker-1');
      expect(first.acquired).toBe(true);

      const second = lock.acquire('my-lock', 5000, 'worker-2');
      expect(second.acquired).toBe(false);
      expect(second.owner).toBe('worker-1');
    });

    test('allows acquire after lock expires', () => {
      // Acquire with 1ms TTL
      const first = lock.acquire('my-lock', 1, 'worker-1');
      expect(first.acquired).toBe(true);

      // Wait for expiration
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }

      const second = lock.acquire('my-lock', 5000, 'worker-2');
      expect(second.acquired).toBe(true);
      expect(second.owner).toBe('worker-2');
    });

    test('allows different keys independently', () => {
      const first = lock.acquire('lock-a', 5000, 'worker-1');
      const second = lock.acquire('lock-b', 5000, 'worker-2');
      expect(first.acquired).toBe(true);
      expect(second.acquired).toBe(true);
    });
  });

  describe('release', () => {
    test('releases a lock owned by the caller', () => {
      lock.acquire('my-lock', 5000, 'worker-1');
      const released = lock.release('my-lock', 'worker-1');
      expect(released).toBe(true);

      // Can acquire again
      const result = lock.acquire('my-lock', 5000, 'worker-2');
      expect(result.acquired).toBe(true);
    });

    test('does not release lock with wrong owner', () => {
      lock.acquire('my-lock', 5000, 'worker-1');
      const released = lock.release('my-lock', 'worker-2');
      expect(released).toBe(false);

      expect(lock.isLocked('my-lock')).toBe(true);
    });

    test('returns false for non-existent lock', () => {
      expect(lock.release('nope', 'worker-1')).toBe(false);
    });
  });

  describe('forceRelease', () => {
    test('releases lock regardless of owner', () => {
      lock.acquire('my-lock', 5000, 'worker-1');
      const released = lock.forceRelease('my-lock');
      expect(released).toBe(true);

      expect(lock.isLocked('my-lock')).toBe(false);
    });

    test('returns false for non-existent lock', () => {
      expect(lock.forceRelease('nope')).toBe(false);
    });
  });

  describe('refresh', () => {
    test('extends TTL for matching owner', () => {
      lock.acquire('my-lock', 100, 'worker-1');
      const refreshed = lock.refresh('my-lock', 10000, 'worker-1');
      expect(refreshed).toBe(true);

      // Still locked after original TTL would have expired
      expect(lock.isLocked('my-lock')).toBe(true);
    });

    test('fails to refresh with wrong owner', () => {
      lock.acquire('my-lock', 5000, 'worker-1');
      const refreshed = lock.refresh('my-lock', 10000, 'worker-2');
      expect(refreshed).toBe(false);
    });

    test('fails to refresh non-existent lock', () => {
      expect(lock.refresh('nope', 5000, 'worker-1')).toBe(false);
    });
  });

  describe('isLocked', () => {
    test('returns true for active lock', () => {
      lock.acquire('my-lock', 5000);
      expect(lock.isLocked('my-lock')).toBe(true);
    });

    test('returns false for expired lock', () => {
      lock.acquire('my-lock', 1);
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }
      expect(lock.isLocked('my-lock')).toBe(false);
    });

    test('returns false for non-existent lock', () => {
      expect(lock.isLocked('nope')).toBe(false);
    });
  });

  describe('pruneExpired', () => {
    test('removes all expired locks', () => {
      lock.acquire('lock-1', 1, 'w1');
      lock.acquire('lock-2', 1, 'w2');
      lock.acquire('lock-3', 60000, 'w3');

      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }

      const pruned = lock.pruneExpired();
      expect(pruned).toBe(2);

      expect(lock.isLocked('lock-1')).toBe(false);
      expect(lock.isLocked('lock-2')).toBe(false);
      expect(lock.isLocked('lock-3')).toBe(true);
    });
  });

  describe('withLock', () => {
    test('executes function while holding lock', async () => {
      let executed = false;
      await lock.withLock('my-lock', 5000, () => {
        expect(lock.isLocked('my-lock')).toBe(true);
        executed = true;
      });
      expect(executed).toBe(true);
      expect(lock.isLocked('my-lock')).toBe(false);
    });

    test('releases lock even when function throws', async () => {
      try {
        await lock.withLock('my-lock', 5000, () => {
          throw new Error('boom');
        });
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(Error);
        if (e instanceof Error) expect(e.message).toBe('boom');
      }
      expect(lock.isLocked('my-lock')).toBe(false);
    });

    test('throws when lock is unavailable', async () => {
      lock.acquire('my-lock', 5000, 'someone-else');

      expect(lock.withLock('my-lock', 5000, () => {})).rejects.toThrow(
        'Failed to acquire lock: my-lock'
      );
    });

    test('works with async functions', async () => {
      const result = await lock.withLock('my-lock', 5000, async () => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return 42;
      });
      expect(result).toBe(42);
      expect(lock.isLocked('my-lock')).toBe(false);
    });
  });
});
