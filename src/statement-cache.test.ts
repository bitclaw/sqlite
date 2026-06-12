import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { StatementCache } from './statement-cache';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.run('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)');
});

afterEach(() => {
  db.close();
});

describe('StatementCache', () => {
  test('get returns null on miss', () => {
    const cache = new StatementCache();
    expect(cache.get('SELECT 1')).toBeNull();
  });

  test('set + get returns cached statement', () => {
    const cache = new StatementCache();
    const stmt = db.query('SELECT 1');
    cache.set('SELECT 1', stmt);
    expect(cache.get('SELECT 1')).toBe(stmt);
  });

  test('LRU eviction: oldest entry removed when maxSize exceeded', () => {
    const cache = new StatementCache({ maxSize: 2 });
    const s1 = db.query('SELECT 1');
    const s2 = db.query('SELECT 2');
    const s3 = db.query('SELECT 3');

    cache.set('SELECT 1', s1);
    cache.set('SELECT 2', s2);
    cache.set('SELECT 3', s3); // evicts SELECT 1

    expect(cache.get('SELECT 1')).toBeNull();
    expect(cache.get('SELECT 2')).toBe(s2);
    expect(cache.get('SELECT 3')).toBe(s3);
  });

  test('LRU eviction: recently accessed entry survives', () => {
    const cache = new StatementCache({ maxSize: 2 });
    const s1 = db.query('SELECT 1');
    const s2 = db.query('SELECT 2');
    const s3 = db.query('SELECT 3');

    cache.set('SELECT 1', s1);
    cache.set('SELECT 2', s2);
    cache.get('SELECT 1'); // promote SELECT 1 to MRU
    cache.set('SELECT 3', s3); // evicts SELECT 2 (now LRU)

    expect(cache.get('SELECT 1')).toBe(s1);
    expect(cache.get('SELECT 2')).toBeNull();
    expect(cache.get('SELECT 3')).toBe(s3);
  });

  test('getOrPrepare: prepares and caches on miss', () => {
    const cache = new StatementCache();
    const stmt = cache.getOrPrepare(db, 'SELECT 1');
    expect(stmt).toBeDefined();
    expect(cache.getStats().misses).toBe(1);
    expect(cache.getStats().hits).toBe(0);
  });

  test('getOrPrepare: returns cached statement on hit', () => {
    const cache = new StatementCache();
    const s1 = cache.getOrPrepare(db, 'SELECT 1');
    const s2 = cache.getOrPrepare(db, 'SELECT 1');
    expect(s1).toBe(s2);
    expect(cache.getStats().hits).toBe(1);
    expect(cache.getStats().misses).toBe(1);
  });

  test('getOrPrepare normalizes whitespace', () => {
    const cache = new StatementCache();
    const s1 = cache.getOrPrepare(db, 'SELECT  1');
    const s2 = cache.getOrPrepare(db, 'SELECT 1');
    expect(s1).toBe(s2);
    expect(cache.getStats().misses).toBe(1);
  });

  test('getStats returns correct hits/misses/hitRate', () => {
    const cache = new StatementCache();
    cache.getOrPrepare(db, 'SELECT 1'); // miss
    cache.getOrPrepare(db, 'SELECT 1'); // hit
    cache.getOrPrepare(db, 'SELECT 2'); // miss

    const stats = cache.getStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.size).toBe(2);
    expect(stats.hitRate).toBeCloseTo(33.33, 1);
  });

  test('clear resets cache and stats', () => {
    const cache = new StatementCache();
    cache.getOrPrepare(db, 'SELECT 1');
    cache.getOrPrepare(db, 'SELECT 1');
    cache.clear();

    const stats = cache.getStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.size).toBe(0);
    expect(cache.get('SELECT 1')).toBeNull();
  });
});
