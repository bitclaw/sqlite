import { Database } from 'bun:sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test
} from 'bun:test';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// =============================================================================
// SQLite Behavioral Tests (bun:sqlite)
// =============================================================================
// These tests verify SQLite behavior using bun:sqlite driver.
// Migrated from better-sqlite3 for 3-6x faster read performance.
//
// Test categories:
// - Basic Operations: SELECT, INSERT, UPDATE, DELETE
// - Prepared Statements: Caching, parameterization
// - Transactions: Commit, rollback, savepoints
// - WAL Mode: Journaling, concurrency
// - Error Handling: Constraints, missing tables
// - Performance: Statement caching behavior
// =============================================================================

// Test database path
const TEST_DIR = join(tmpdir(), 'sqlite-saas-tests');
const getTestDbPath = () =>
  join(TEST_DIR, `test-${randomBytes(8).toString('hex')}.db`);

let db: Database;
let dbPath: string;

beforeAll(() => {
  // Ensure test directory exists
  if (!existsSync(TEST_DIR)) {
    mkdirSync(TEST_DIR, { recursive: true });
  }
});

afterAll(() => {
  // Clean up test directory
  try {
    rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

beforeEach(() => {
  dbPath = getTestDbPath();
  db = new Database(dbPath, { create: true });

  // Apply standard pragmas (bun:sqlite uses run() instead of pragma())
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA synchronous = NORMAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
});

afterEach(() => {
  if (db) {
    db.close();

    // Clean up database files
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
      if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
    } catch {
      // Ignore cleanup errors
    }
  }
});

// =============================================================================
// BASIC OPERATIONS
// =============================================================================

describe('Basic Operations', () => {
  beforeEach(() => {
    db.run(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				name TEXT NOT NULL,
				email TEXT UNIQUE,
				created_at TEXT DEFAULT (datetime('now'))
			)
		`);
  });

  test('should execute SELECT and return rows', () => {
    db.run(
      `INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`
    );
    db.run(`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`);

    const rows = db.query('SELECT * FROM users ORDER BY name').all();

    expect(rows).toHaveLength(2);
    expect((rows[0] as { name: string }).name).toBe('Alice');
    expect((rows[1] as { name: string }).name).toBe('Bob');
  });

  test('should execute INSERT and return lastInsertRowid', () => {
    const stmt = db.query('INSERT INTO users (name, email) VALUES (?, ?)');
    // bun:sqlite stmt.run() returns { changes, lastInsertRowid }
    const result = stmt.run('Charlie', 'charlie@example.com');

    expect(result.lastInsertRowid).toBe(1);
    expect(result.changes).toBe(1);
  });

  test('should execute UPDATE and return changes count', () => {
    db.run(
      `INSERT INTO users (name, email) VALUES ('Dave', 'dave@example.com')`
    );
    db.run(`INSERT INTO users (name, email) VALUES ('Eve', 'eve@example.com')`);

    const stmt = db.query(
      "UPDATE users SET name = 'Updated' WHERE name LIKE 'D%'"
    );
    const result = stmt.run();

    expect(result.changes).toBe(1);
  });

  test('should execute DELETE and return changes count', () => {
    db.run(
      `INSERT INTO users (name, email) VALUES ('Frank', 'frank@example.com')`
    );
    db.run(
      `INSERT INTO users (name, email) VALUES ('Grace', 'grace@example.com')`
    );

    const stmt = db.query('DELETE FROM users WHERE name = ?');
    const result = stmt.run('Frank');

    expect(result.changes).toBe(1);

    const remaining = db.query('SELECT COUNT(*) as count FROM users').get() as {
      count: number;
    };
    expect(remaining.count).toBe(1);
  });

  test('should handle NULL values correctly', () => {
    const stmt = db.query('INSERT INTO users (name, email) VALUES (?, ?)');
    stmt.run('NoEmail', null);

    const row = db
      .query('SELECT * FROM users WHERE name = ?')
      .get('NoEmail') as { name: string; email: string | null } | null;

    expect(row?.name).toBe('NoEmail');
    expect(row?.email).toBeNull();
  });

  test('should return null for non-existent rows', () => {
    const row = db.query('SELECT * FROM users WHERE id = ?').get(999);

    // bun:sqlite returns null for non-existent rows (not undefined)
    expect(row).toBeNull();
  });
});

// =============================================================================
// PREPARED STATEMENTS
// =============================================================================

describe('Prepared Statements', () => {
  beforeEach(() => {
    db.run(`
			CREATE TABLE items (
				id INTEGER PRIMARY KEY,
				value TEXT
			)
		`);
  });

  test('should reuse prepared statements', () => {
    const stmt = db.query('INSERT INTO items (value) VALUES (?)');

    stmt.run('first');
    stmt.run('second');
    stmt.run('third');

    const count = db.query('SELECT COUNT(*) as count FROM items').get() as {
      count: number;
    };
    expect(count.count).toBe(3);
  });

  test('should handle positional parameters', () => {
    db.run(`INSERT INTO items (id, value) VALUES (1, 'test')`);

    const row = db
      .query('SELECT * FROM items WHERE id = ? AND value = ?')
      .get(1, 'test') as { id: number; value: string } | null;

    expect(row?.id).toBe(1);
    expect(row?.value).toBe('test');
  });

  test('should handle named parameters with $prefix', () => {
    // bun:sqlite uses $name syntax for named parameters
    const stmt = db.query('INSERT INTO items (id, value) VALUES ($id, $value)');
    stmt.run({ $id: 10, $value: 'named' });

    const row = db.query('SELECT * FROM items WHERE id = ?').get(10) as {
      id: number;
      value: string;
    } | null;
    expect(row?.value).toBe('named');
  });

  test('should handle array binding with spread', () => {
    const values = [1, 'spread-test'];
    const stmt = db.query('INSERT INTO items (id, value) VALUES (?, ?)');
    stmt.run(...values);

    const row = db.query('SELECT * FROM items WHERE id = ?').get(1) as {
      id: number;
      value: string;
    } | null;
    expect(row?.value).toBe('spread-test');
  });

  test('should get single column value', () => {
    db.run(`INSERT INTO items (id, value) VALUES (1, 'column-test')`);

    // bun:sqlite doesn't have pluck(), just select the column directly
    const row = db.query('SELECT value FROM items WHERE id = ?').get(1) as {
      value: string;
    };
    expect(row.value).toBe('column-test');
  });
});

// =============================================================================
// TRANSACTIONS
// =============================================================================

describe('Transactions', () => {
  beforeEach(() => {
    db.run(`
			CREATE TABLE accounts (
				id INTEGER PRIMARY KEY,
				balance INTEGER NOT NULL DEFAULT 0
			)
		`);
    db.run(`INSERT INTO accounts (id, balance) VALUES (1, 100), (2, 50)`);
  });

  test('should commit transaction on success', () => {
    db.run('BEGIN IMMEDIATE');
    db.run('UPDATE accounts SET balance = balance - 25 WHERE id = 1');
    db.run('UPDATE accounts SET balance = balance + 25 WHERE id = 2');
    db.run('COMMIT');

    const acc1 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(1) as {
      balance: number;
    };
    const acc2 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(2) as {
      balance: number;
    };

    expect(acc1.balance).toBe(75);
    expect(acc2.balance).toBe(75);
  });

  test('should rollback transaction on error', () => {
    try {
      db.run('BEGIN IMMEDIATE');
      db.run('UPDATE accounts SET balance = balance - 25 WHERE id = 1');
      db.run('UPDATE accounts SET balance = -999 WHERE id = 999'); // Valid SQL, no error
      db.run('ROLLBACK');
    } catch {
      db.run('ROLLBACK');
    }

    const acc1 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(1) as {
      balance: number;
    };
    expect(acc1.balance).toBe(100); // Original value
  });

  test('should support nested transactions via savepoints', () => {
    db.run('BEGIN IMMEDIATE');
    db.run('UPDATE accounts SET balance = balance - 10 WHERE id = 1');

    db.run('SAVEPOINT sp1');
    db.run('UPDATE accounts SET balance = balance - 5 WHERE id = 1');

    // Rollback to savepoint
    db.run('ROLLBACK TO sp1');

    db.run('COMMIT');

    const acc1 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(1) as {
      balance: number;
    };
    expect(acc1.balance).toBe(90); // Only first update applied
  });

  test('should handle BEGIN IMMEDIATE for write locks', () => {
    // BEGIN IMMEDIATE acquires a RESERVED lock immediately
    db.run('BEGIN IMMEDIATE');
    db.run('UPDATE accounts SET balance = 200 WHERE id = 1');
    db.run('COMMIT');

    const acc1 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(1) as {
      balance: number;
    };
    expect(acc1.balance).toBe(200);
  });

  test('should use transaction with db.transaction() helper', () => {
    // bun:sqlite provides db.transaction() for atomic operations
    const transfer = db.transaction(
      (from: number, to: number, amount: number) => {
        db.query('UPDATE accounts SET balance = balance - ? WHERE id = ?').run(
          amount,
          from
        );
        db.query('UPDATE accounts SET balance = balance + ? WHERE id = ?').run(
          amount,
          to
        );
        return { from, to, amount };
      }
    );

    const result = transfer(1, 2, 30);

    expect(result).toEqual({ from: 1, to: 2, amount: 30 });

    const acc1 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(1) as {
      balance: number;
    };
    const acc2 = db
      .query('SELECT balance FROM accounts WHERE id = ?')
      .get(2) as {
      balance: number;
    };

    expect(acc1.balance).toBe(70);
    expect(acc2.balance).toBe(80);
  });
});

// =============================================================================
// WAL MODE
// =============================================================================

describe('WAL Mode', () => {
  test('should enable WAL mode', () => {
    const result = db.query('PRAGMA journal_mode').get() as {
      journal_mode: string;
    };
    expect(result.journal_mode).toBe('wal');
  });

  test('should checkpoint correctly', () => {
    db.run('CREATE TABLE wal_test (id INTEGER PRIMARY KEY)');

    for (let i = 0; i < 10; i++) {
      db.run(`INSERT INTO wal_test (id) VALUES (${i})`);
    }

    // Force checkpoint
    const result = db.query('PRAGMA wal_checkpoint(TRUNCATE)').all();

    expect(Array.isArray(result)).toBe(true);
  });

  test('should handle concurrent reads', () => {
    db.run('CREATE TABLE concurrent_test (id INTEGER PRIMARY KEY, value TEXT)');
    db.run(`INSERT INTO concurrent_test (id, value) VALUES (1, 'test')`);

    // Multiple reads should work
    const results = [];
    for (let i = 0; i < 5; i++) {
      const row = db.query('SELECT * FROM concurrent_test WHERE id = 1').get();
      results.push(row);
    }

    expect(results).toHaveLength(5);
    for (const row of results) {
      expect((row as { value: string }).value).toBe('test');
    }
  });
});

// =============================================================================
// ERROR HANDLING
// =============================================================================

describe('Error Handling', () => {
  test('should handle UNIQUE constraint violations', () => {
    db.run(`
			CREATE TABLE unique_test (
				id INTEGER PRIMARY KEY,
				email TEXT UNIQUE
			)
		`);

    db.run(`INSERT INTO unique_test (email) VALUES ('test@example.com')`);

    expect(() => {
      db.run(`INSERT INTO unique_test (email) VALUES ('test@example.com')`);
    }).toThrow(/UNIQUE constraint failed/);
  });

  test('should handle NOT NULL constraint violations', () => {
    db.run(`
			CREATE TABLE notnull_test (
				id INTEGER PRIMARY KEY,
				required TEXT NOT NULL
			)
		`);

    expect(() => {
      db.run(`INSERT INTO notnull_test (required) VALUES (NULL)`);
    }).toThrow(/NOT NULL constraint failed/);
  });

  test('should handle FOREIGN KEY constraint violations', () => {
    db.run(`
			CREATE TABLE parent (id INTEGER PRIMARY KEY);
			CREATE TABLE child (
				id INTEGER PRIMARY KEY,
				parent_id INTEGER REFERENCES parent(id)
			)
		`);

    expect(() => {
      db.run(`INSERT INTO child (parent_id) VALUES (999)`);
    }).toThrow(/FOREIGN KEY constraint failed/);
  });

  test('should handle missing tables', () => {
    expect(() => {
      db.run('SELECT * FROM nonexistent_table');
    }).toThrow(/no such table/);
  });

  test('should handle syntax errors', () => {
    expect(() => {
      db.run('SELEKT * FROM users');
    }).toThrow();
  });

  test('should handle CHECK constraint violations', () => {
    db.run(`
			CREATE TABLE check_test (
				id INTEGER PRIMARY KEY,
				amount INTEGER CHECK(amount >= 0)
			)
		`);

    expect(() => {
      db.run(`INSERT INTO check_test (amount) VALUES (-1)`);
    }).toThrow(/CHECK constraint failed/);
  });
});

// =============================================================================
// DATA TYPES
// =============================================================================

describe('Data Types', () => {
  beforeEach(() => {
    db.run(`
			CREATE TABLE types_test (
				id INTEGER PRIMARY KEY,
				int_val INTEGER,
				real_val REAL,
				text_val TEXT,
				blob_val BLOB
			)
		`);
  });

  test('should handle INTEGER values', () => {
    const stmt = db.query('INSERT INTO types_test (int_val) VALUES (?)');
    stmt.run(42);
    stmt.run(-999);
    stmt.run(Number.MAX_SAFE_INTEGER);

    const rows = db
      .query('SELECT int_val FROM types_test ORDER BY id')
      .all() as {
      int_val: number;
    }[];

    expect(rows[0]!.int_val).toBe(42);
    expect(rows[1]!.int_val).toBe(-999);
    expect(rows[2]!.int_val).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('should handle REAL/FLOAT values', () => {
    const stmt = db.query('INSERT INTO types_test (real_val) VALUES (?)');
    stmt.run(Math.PI);
    stmt.run(-0.001);

    const rows = db
      .query('SELECT real_val FROM types_test ORDER BY id')
      .all() as {
      real_val: number;
    }[];

    expect(rows[0]!.real_val).toBeCloseTo(Math.PI);
    expect(rows[1]!.real_val).toBeCloseTo(-0.001);
  });

  test('should handle TEXT values', () => {
    const stmt = db.query('INSERT INTO types_test (text_val) VALUES (?)');
    stmt.run('Hello, World!');
    stmt.run('Unicode: 你好 🌍');
    stmt.run('');

    const rows = db
      .query('SELECT text_val FROM types_test ORDER BY id')
      .all() as {
      text_val: string;
    }[];

    expect(rows[0]!.text_val).toBe('Hello, World!');
    expect(rows[1]!.text_val).toBe('Unicode: 你好 🌍');
    expect(rows[2]!.text_val).toBe('');
  });

  test('should handle BLOB values', () => {
    // bun:sqlite uses Uint8Array for BLOBs
    const buffer = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
    const stmt = db.query('INSERT INTO types_test (blob_val) VALUES (?)');
    stmt.run(buffer);

    const row = db.query('SELECT blob_val FROM types_test').get() as {
      blob_val: Uint8Array;
    };

    expect(row.blob_val instanceof Uint8Array).toBe(true);
    expect(Array.from(row.blob_val)).toEqual(Array.from(buffer));
  });

  test('should handle JSON stored as TEXT', () => {
    const jsonData = { name: 'test', values: [1, 2, 3] };
    const stmt = db.query('INSERT INTO types_test (text_val) VALUES (?)');
    stmt.run(JSON.stringify(jsonData));

    const row = db.query('SELECT text_val FROM types_test').get() as {
      text_val: string;
    };
    const parsed = JSON.parse(row.text_val);

    expect(parsed).toEqual(jsonData);
  });
});

// =============================================================================
// AGGREGATE FUNCTIONS
// =============================================================================

describe('Aggregate Functions', () => {
  beforeEach(() => {
    db.run(`
			CREATE TABLE numbers (value INTEGER);
			INSERT INTO numbers VALUES (1), (2), (3), (4), (5);
		`);
  });

  test('should handle COUNT', () => {
    const result = db.query('SELECT COUNT(*) as count FROM numbers').get() as {
      count: number;
    };
    expect(result.count).toBe(5);
  });

  test('should handle SUM', () => {
    const result = db
      .query('SELECT SUM(value) as total FROM numbers')
      .get() as {
      total: number;
    };
    expect(result.total).toBe(15);
  });

  test('should handle AVG', () => {
    const result = db.query('SELECT AVG(value) as avg FROM numbers').get() as {
      avg: number;
    };
    expect(result.avg).toBe(3);
  });

  test('should handle MIN and MAX', () => {
    const result = db
      .query('SELECT MIN(value) as min, MAX(value) as max FROM numbers')
      .get() as {
      min: number;
      max: number;
    };

    expect(result.min).toBe(1);
    expect(result.max).toBe(5);
  });

  test('should handle GROUP BY', () => {
    db.run(`
			CREATE TABLE grouped (category TEXT, amount INTEGER);
			INSERT INTO grouped VALUES ('A', 10), ('A', 20), ('B', 30);
		`);

    const results = db
      .query(
        'SELECT category, SUM(amount) as total FROM grouped GROUP BY category ORDER BY category'
      )
      .all() as { category: string; total: number }[];

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ category: 'A', total: 30 });
    expect(results[1]).toEqual({ category: 'B', total: 30 });
  });
});

// =============================================================================
// PERFORMANCE PATTERNS
// =============================================================================

describe('Performance Patterns', () => {
  test('should handle batch inserts efficiently', () => {
    db.run(`CREATE TABLE batch_test (id INTEGER PRIMARY KEY, value TEXT)`);

    const insert = db.query('INSERT INTO batch_test (value) VALUES (?)');
    // biome-ignore lint/nursery/noShadow: variable name is clear in context
    const insertMany = db.transaction((items: string[]) => {
      for (const item of items) {
        insert.run(item);
      }
    });

    const items = Array.from({ length: 1000 }, (_, i) => `item-${i}`);
    insertMany(items);

    const count = db
      .query('SELECT COUNT(*) as count FROM batch_test')
      .get() as {
      count: number;
    };
    expect(count.count).toBe(1000);
  });

  test('should create and use indexes', () => {
    db.run(`
			CREATE TABLE indexed_test (
				id INTEGER PRIMARY KEY,
				indexed_col TEXT,
				value TEXT
			);
			CREATE INDEX idx_indexed_col ON indexed_test(indexed_col);
		`);

    // Insert test data
    const insert = db.query(
      'INSERT INTO indexed_test (indexed_col, value) VALUES (?, ?)'
    );
    for (let i = 0; i < 100; i++) {
      insert.run(`key-${i}`, `value-${i}`);
    }

    // Query should use index
    const explain = db
      .query(
        'EXPLAIN QUERY PLAN SELECT * FROM indexed_test WHERE indexed_col = ?'
      )
      .all('key-50') as { detail: string }[];

    // Check that index is used (detail should mention the index)
    const usesIndex = explain.some(row =>
      row.detail?.includes('idx_indexed_col')
    );
    expect(usesIndex).toBe(true);
  });
});
