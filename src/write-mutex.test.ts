import { describe, expect, test } from 'bun:test';
import { WriteMutex, WriteMutexMap } from './write-mutex';

describe('WriteMutex', () => {
  test('executes function and returns result', async () => {
    const mutex = new WriteMutex();
    const result = await mutex.acquire(() => 42);
    expect(result).toBe(42);
  });

  test('executes async function and returns result', async () => {
    const mutex = new WriteMutex();
    const result = await mutex.acquire(async () => {
      await new Promise(resolve => setTimeout(resolve, 10));
      return 'async-result';
    });
    expect(result).toBe('async-result');
  });

  test('serializes concurrent operations', async () => {
    const mutex = new WriteMutex();
    const order: number[] = [];

    const op = (id: number, delayMs: number) =>
      mutex.acquire(async () => {
        order.push(id);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        order.push(id * 10);
      });

    // Start both concurrently - op1 should complete before op2 starts
    await Promise.all([op(1, 50), op(2, 10)]);

    expect(order).toEqual([1, 10, 2, 20]);
  });

  test('releases lock even if function throws', async () => {
    const mutex = new WriteMutex();

    await expect(
      mutex.acquire(() => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Should still be able to acquire after error
    const result = await mutex.acquire(() => 'recovered');
    expect(result).toBe('recovered');
  });

  test('releases lock even if async function rejects', async () => {
    const mutex = new WriteMutex();

    await expect(
      mutex.acquire(async () => {
        throw new Error('async-boom');
      })
    ).rejects.toThrow('async-boom');

    const result = await mutex.acquire(() => 'recovered');
    expect(result).toBe('recovered');
  });
});

describe('WriteMutexMap', () => {
  test('creates separate mutexes per key', async () => {
    const map = new WriteMutexMap();
    const order: string[] = [];

    const op = (key: string, id: string, delayMs: number) =>
      map.withLock(key, async () => {
        order.push(`${key}-${id}-start`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        order.push(`${key}-${id}-end`);
      });

    // Different keys should run concurrently
    await Promise.all([op('a', '1', 50), op('b', '1', 50)]);

    // Both should have started before either ended
    expect(order.indexOf('a-1-start')).toBeLessThan(order.indexOf('a-1-end'));
    expect(order.indexOf('b-1-start')).toBeLessThan(order.indexOf('b-1-end'));
    // Both started before the other's end (concurrent)
    expect(order.indexOf('a-1-start')).toBeLessThan(order.indexOf('b-1-end'));
    expect(order.indexOf('b-1-start')).toBeLessThan(order.indexOf('a-1-end'));
  });

  test('serializes operations on the same key', async () => {
    const map = new WriteMutexMap();
    const order: number[] = [];

    const op = (id: number, delayMs: number) =>
      map.withLock('same-key', async () => {
        order.push(id);
        await new Promise(resolve => setTimeout(resolve, delayMs));
        order.push(id * 10);
      });

    await Promise.all([op(1, 30), op(2, 10)]);

    expect(order).toEqual([1, 10, 2, 20]);
  });

  test('isLocked is true while a call is queued or running, false after release', async () => {
    const map = new WriteMutexMap();
    let resolveHold: () => void;
    const hold = new Promise<void>(resolve => {
      resolveHold = resolve;
    });

    expect(map.isLocked('key1')).toBe(false);

    const done = map.withLock('key1', async () => {
      await hold;
    });

    expect(map.isLocked('key1')).toBe(true);
    resolveHold!();
    await done;
    expect(map.isLocked('key1')).toBe(false);
  });

  test('isLocked is false for a key with no mutex yet', () => {
    const map = new WriteMutexMap();
    expect(map.isLocked('never-used')).toBe(false);
  });

  test('delete removes mutex for key', () => {
    const map = new WriteMutexMap();

    // Create a mutex by using it
    void map.withLock('key1', () => {});
    expect(map.size).toBe(1);

    map.delete('key1');
    expect(map.size).toBe(0);
  });

  test('size tracks number of mutexes', () => {
    const map = new WriteMutexMap();

    void map.withLock('a', () => {});
    void map.withLock('b', () => {});
    expect(map.size).toBe(2);
  });
});
