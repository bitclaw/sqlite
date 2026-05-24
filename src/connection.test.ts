import type { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  checkHealth,
  closeConnection,
  getStats,
  initializeConnection
} from './connection';

describe('initializeConnection', () => {
  let db: Database;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
  });

  test('given a memory database, when initialized, then it applies performance PRAGMAs', () => {
    db = initializeConnection({ path: ':memory:' });

    const foreignKeys = db.query('PRAGMA foreign_keys').get() as Record<
      string,
      number
    >;
    expect(Object.values(foreignKeys)[0]).toBe(1);

    const synchronous = db.query('PRAGMA synchronous').get() as Record<
      string,
      number
    >;
    expect(Object.values(synchronous)[0]).toBe(1); // NORMAL = 1

    const tempStore = db.query('PRAGMA temp_store').get() as Record<
      string,
      number
    >;
    expect(Object.values(tempStore)[0]).toBe(2); // MEMORY = 2
  });

  test('given a file-backed database, when initialized, then it sets WAL mode', () => {
    const tmpPath = `/tmp/connection-test-${Date.now()}.db`;
    db = initializeConnection({ path: tmpPath });

    const journalMode = db.query('PRAGMA journal_mode').get() as Record<
      string,
      string
    >;
    expect(Object.values(journalMode)[0]).toBe('wal');

    // Cleanup
    try {
      require('node:fs').unlinkSync(tmpPath);
      require('node:fs').unlinkSync(`${tmpPath}-wal`);
      require('node:fs').unlinkSync(`${tmpPath}-shm`);
    } catch {
      // ignore
    }
  });
});

describe('PRAGMA allow-list', () => {
  let db: Database;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
  });

  test('given an allowed PRAGMA, when getStats is called, then it returns values', () => {
    db = initializeConnection({ path: ':memory:' });
    const stats = getStats(db);

    expect(stats).toHaveProperty('journalMode');
    expect(stats).toHaveProperty('pageCount');
    expect(stats).toHaveProperty('cacheSize');
    expect(stats).toHaveProperty('foreignKeys');
    expect(stats).not.toHaveProperty('error');
  });

  test('given a disallowed PRAGMA, when checkHealth internally queries it, then allowed PRAGMAs work', () => {
    db = initializeConnection({ path: ':memory:' });
    const health = checkHealth(db);

    expect(health.healthy).toBe(true);
    expect(health.details.journalMode).toBeDefined();
    expect(health.details.pageCount).toBeDefined();
    expect(health.details.pageSize).toBeDefined();
  });
});

describe('checkHealth', () => {
  let db: Database;

  afterEach(() => {
    try {
      db?.close();
    } catch {
      // already closed
    }
  });

  test('given a healthy database, when checkHealth is called, then it returns healthy status', () => {
    db = initializeConnection({ path: ':memory:' });
    const health = checkHealth(db);

    expect(health.healthy).toBe(true);
    expect(health.details.accessible).toBe(true);
    expect(typeof health.details.databaseSize).toBe('number');
  });

  test('given a closed database, when checkHealth is called, then it returns unhealthy status', () => {
    db = initializeConnection({ path: ':memory:' });
    db.close();

    const health = checkHealth(db);

    expect(health.healthy).toBe(false);
    expect(health.details.accessible).toBe(false);
    expect(health.details.error).toBeDefined();
  });
});

describe('closeConnection', () => {
  test('given an open database, when closeConnection is called, then it closes without error', () => {
    const db = initializeConnection({ path: ':memory:' });

    expect(() => closeConnection(db)).not.toThrow();
  });

  test('given a closed database, when closeConnection is called, then it handles the error gracefully', () => {
    const db = initializeConnection({ path: ':memory:' });
    db.close();

    expect(() => closeConnection(db)).not.toThrow();
  });
});

describe('getStats', () => {
  test('given a healthy database, when getStats is called, then it returns all expected fields', () => {
    const db = initializeConnection({ path: ':memory:' });

    const stats = getStats(db);

    expect(stats).toHaveProperty('journalMode');
    expect(stats).toHaveProperty('pageCount');
    expect(stats).toHaveProperty('pageSize');
    expect(stats).toHaveProperty('cacheSize');
    expect(stats).toHaveProperty('mmapSize');
    expect(stats).toHaveProperty('walAutocheckpoint');
    expect(stats).toHaveProperty('synchronous');
    expect(stats).toHaveProperty('foreignKeys');

    db.close();
  });

  test('given a closed database, when getStats is called, then it returns an error field', () => {
    const db = initializeConnection({ path: ':memory:' });
    db.close();

    const stats = getStats(db);
    expect(stats).toHaveProperty('error');
  });
});
