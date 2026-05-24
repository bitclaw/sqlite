import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachified, JsonCache } from './json-cache';

const createTempDir = async (): Promise<string> => {
  const dir = join(
    tmpdir(),
    `json-cache-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

describe('JsonCache', () => {
  let cache: JsonCache;
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await createTempDir();
    cache = new JsonCache({ cacheDir, defaultTtl: 300_000 });
    await cache.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe('given a cache, when set and get are called', () => {
    test('then it atomically writes and reads back the value', async () => {
      await cache.set('user:1', { name: 'Alice', age: 30 });
      const result = await cache.get<{ name: string; age: number }>('user:1');

      expect(result).toEqual({ name: 'Alice', age: 30 });
    });

    test('then the file exists on disk', async () => {
      await cache.set('disk-check', 'persisted');
      const exists = await cache.has('disk-check');
      expect(exists).toBe(true);
    });

    test('then it returns null for missing keys', async () => {
      const result = await cache.get('nonexistent');
      expect(result).toBeNull();
    });

    test('then it overwrites existing entries', async () => {
      await cache.set('key', 'first');
      await cache.set('key', 'second');
      expect(await cache.get<string>('key')).toBe('second');
    });

    test('then it handles various value types', async () => {
      await cache.set('number', 42);
      await cache.set('array', [1, 2, 3]);
      await cache.set('null-val', null);
      await cache.set('bool', true);

      expect(await cache.get<number>('number')).toBe(42);
      expect(await cache.get<number[]>('array')).toEqual([1, 2, 3]);
      expect(await cache.get('null-val')).toBeNull();
      expect(await cache.get<boolean>('bool')).toBe(true);
    });
  });

  describe('given a short TTL, when the entry expires', () => {
    test('then get returns null after TTL', async () => {
      await cache.set('ephemeral', 'gone', { ttl: 50 });

      expect(await cache.get<string>('ephemeral')).toBe('gone');

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(await cache.get('ephemeral')).toBeNull();
    });
  });

  describe('given SWR is configured, when TTL expires but within SWR window', () => {
    test('then get returns stale value during SWR window', async () => {
      await cache.set('swr-key', 'stale-ok', { ttl: 50, swr: 200 });

      await new Promise(resolve => setTimeout(resolve, 60));

      // Past TTL but within SWR window (50 + 200 = 250ms)
      const result = await cache.get('swr-key');
      expect(result).toBe('stale-ok');
    });

    test('then get returns null after SWR window expires', async () => {
      await cache.set('swr-key', 'fully-gone', { ttl: 50, swr: 50 });

      await new Promise(resolve => setTimeout(resolve, 110));

      // Past both TTL and SWR window (50 + 50 = 100ms)
      expect(await cache.get('swr-key')).toBeNull();
    });
  });

  describe('given expired entries, when cleanup is called', () => {
    test('then it removes expired entries and returns the count', async () => {
      await cache.set('expired1', 'old', { ttl: 50 });
      await cache.set('expired2', 'old', { ttl: 50 });
      await cache.set('fresh', 'new', { ttl: 300_000 });

      await new Promise(resolve => setTimeout(resolve, 60));

      const cleaned = await cache.cleanup();
      expect(cleaned).toBe(2);

      expect(await cache.get<string>('fresh')).toBe('new');
    });

    test('then it respects SWR window during cleanup', async () => {
      await cache.set('swr-entry', 'keep', { ttl: 50, swr: 500 });

      await new Promise(resolve => setTimeout(resolve, 60));

      const cleaned = await cache.cleanup();
      expect(cleaned).toBe(0);
    });
  });

  describe('given a corrupted cache file, when get is called', () => {
    test('then it returns null for invalid JSON', async () => {
      const filePath = join(cacheDir, 'corrupted.json');
      await fs.writeFile(filePath, '{invalid json!!!}', 'utf-8');

      const result = await cache.get('corrupted');
      expect(result).toBeNull();
    });

    test('then it returns null for valid JSON with wrong shape', async () => {
      const filePath = join(cacheDir, 'wrong-shape.json');
      await fs.writeFile(filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');

      const result = await cache.get('wrong-shape');
      expect(result).toBeNull();
    });

    test('then cleanup removes unparseable files', async () => {
      const filePath = join(cacheDir, 'bad.json');
      await fs.writeFile(filePath, 'not-json', 'utf-8');

      const cleaned = await cache.cleanup();
      expect(cleaned).toBe(1);
    });
  });

  describe('given entries, when delete is called', () => {
    test('then it removes the file from disk', async () => {
      await cache.set('to-delete', 'bye');
      await cache.delete('to-delete');

      expect(await cache.has('to-delete')).toBe(false);
      expect(await cache.get('to-delete')).toBeNull();
    });

    test('then deleting a nonexistent key does not throw', async () => {
      await cache.delete('nonexistent');
    });
  });

  describe('given entries, when clear is called', () => {
    test('then it removes all JSON files', async () => {
      await cache.set('a', '1');
      await cache.set('b', '2');
      await cache.set('c', '3');

      await cache.clear();

      const stats = await cache.stats();
      expect(stats.size).toBe(0);
    });
  });

  describe('given entries, when stats is called', () => {
    test('then it returns file count and entry names', async () => {
      await cache.set('alpha', '1');
      await cache.set('beta', '2');

      const stats = await cache.stats();
      expect(stats.size).toBe(2);
      expect(stats.entries).toContain('alpha');
      expect(stats.entries).toContain('beta');
    });
  });

  describe('given keys with special characters, when set/get are called', () => {
    test('then keys are sanitized for the filesystem', async () => {
      await cache.set('user:123/data', 'sanitized');
      const result = await cache.get('user:123/data');
      expect(result).toBe('sanitized');
    });
  });
});

describe('cachified', () => {
  let cache: JsonCache;
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await createTempDir();
    cache = new JsonCache({ cacheDir, defaultTtl: 300_000 });
    await cache.init();
  });

  afterEach(async () => {
    try {
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('given a cache miss, when called, then it fetches fresh value and caches it', async () => {
    let calls = 0;
    const result = await cachified({
      cache,
      key: 'fresh',
      getFreshValue: async () => {
        calls++;
        return 'computed';
      },
      ttl: 60_000
    });

    expect(result).toBe('computed');
    expect(calls).toBe(1);

    // Wait briefly for fire-and-forget cache.set to complete
    await new Promise(resolve => setTimeout(resolve, 20));

    // Second call should hit cache
    const result2 = await cachified({
      cache,
      key: 'fresh',
      getFreshValue: async () => {
        calls++;
        return 'should-not-be-called';
      },
      ttl: 60_000
    });

    expect(result2).toBe('computed');
    expect(calls).toBe(1);
  });
});
