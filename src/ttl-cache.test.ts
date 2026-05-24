import { beforeEach, describe, expect, test } from 'bun:test';
import { TTLCache } from './ttl-cache';

describe('TTLCache', () => {
  let cache: TTLCache<string>;

  beforeEach(() => {
    cache = new TTLCache<string>({ ttl: 1000, maxSize: 5 });
  });

  describe('given a new cache, when set and get are called', () => {
    test('then it stores and retrieves the value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    test('then it returns undefined for missing keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    test('then it tracks size correctly', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      expect(cache.size).toBe(2);
    });

    test('then it overwrites existing keys', () => {
      cache.set('key1', 'first');
      cache.set('key1', 'second');
      expect(cache.get('key1')).toBe('second');
      expect(cache.size).toBe(1);
    });
  });

  describe('given entries with a short TTL, when TTL expires', () => {
    test('then get returns undefined for expired entries', async () => {
      const shortCache = new TTLCache<string>({ ttl: 50 });
      shortCache.set('ephemeral', 'gone-soon');

      expect(shortCache.get('ephemeral')).toBe('gone-soon');

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(shortCache.get('ephemeral')).toBeUndefined();
    });

    test('then expired entries are removed from the map on access', async () => {
      const shortCache = new TTLCache<string>({ ttl: 50 });
      shortCache.set('temp', 'data');

      await new Promise(resolve => setTimeout(resolve, 60));

      shortCache.get('temp');
      expect(shortCache.size).toBe(0);
    });
  });

  describe('given a cache that exceeds maxSize, when set is called', () => {
    test('then expired entries are pruned', async () => {
      const smallCache = new TTLCache<string>({ ttl: 50, maxSize: 3 });

      smallCache.set('a', '1');
      smallCache.set('b', '2');
      smallCache.set('c', '3');

      await new Promise(resolve => setTimeout(resolve, 60));

      // This 4th entry exceeds maxSize, triggering prune of all 3 expired entries
      smallCache.set('d', '4');

      expect(smallCache.size).toBe(1);
      expect(smallCache.get('d')).toBe('4');
      expect(smallCache.get('a')).toBeUndefined();
    });

    test('then non-expired entries survive pruning', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');
      cache.set('d', '4');
      cache.set('e', '5');

      // 6th entry exceeds maxSize=5, but nothing is expired so prune removes 0
      cache.set('f', '6');

      expect(cache.get('a')).toBe('1');
      expect(cache.get('f')).toBe('6');
    });
  });

  describe('given a populated cache, when delete is called', () => {
    test('then it removes the entry and returns true', () => {
      cache.set('key1', 'value1');
      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    test('then it returns false for missing keys', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });
  });

  describe('given a populated cache, when clear is called', () => {
    test('then it removes all entries', () => {
      cache.set('a', '1');
      cache.set('b', '2');
      cache.set('c', '3');

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.get('b')).toBeUndefined();
      expect(cache.get('c')).toBeUndefined();
    });
  });

  describe('given entries, when has is called', () => {
    test('then it returns true for existing non-expired entries', () => {
      cache.set('exists', 'yes');
      expect(cache.has('exists')).toBe(true);
    });

    test('then it returns false for missing entries', () => {
      expect(cache.has('nope')).toBe(false);
    });

    test('then it returns false for expired entries', async () => {
      const shortCache = new TTLCache<string>({ ttl: 50 });
      shortCache.set('temp', 'data');

      await new Promise(resolve => setTimeout(resolve, 60));

      expect(shortCache.has('temp')).toBe(false);
    });
  });

  describe('given expired entries, when prune is called', () => {
    test('then it removes expired entries and returns the count', async () => {
      const shortCache = new TTLCache<string>({ ttl: 50 });
      shortCache.set('a', '1');
      shortCache.set('b', '2');

      await new Promise(resolve => setTimeout(resolve, 60));

      shortCache.set('c', '3'); // fresh entry

      const pruned = shortCache.prune();
      expect(pruned).toBe(2);
      expect(shortCache.size).toBe(1);
      expect(shortCache.get('c')).toBe('3');
    });
  });

  describe('given default options, when no options are provided', () => {
    test('then it uses default ttl of 30s and maxSize of 100', () => {
      const defaultCache = new TTLCache<string>();
      defaultCache.set('key', 'value');
      expect(defaultCache.get('key')).toBe('value');
    });
  });
});
