// packages/sqlite/src/connection.ts
// Database connection initialization and configuration
// Uses bun:sqlite for 3-6x faster reads compared to better-sqlite3
import { Database } from 'bun:sqlite';

export type ConnectionConfig = {
  path: string;
  readonly?: boolean;
  verbose?: boolean;
};

/**
 * Initialize a SQLite database with optimal settings
 */
export function initializeConnection(config: ConnectionConfig): Database {
  const db = new Database(config.path, {
    readonly: config.readonly ?? false,
    create: true
  });

  // Apply optimal PRAGMA settings
  if (config.path !== ':memory:') {
    // WAL mode for better concurrency
    db.run('PRAGMA journal_mode = WAL');

    // Reduced busy timeout for worker coordination
    db.run('PRAGMA busy_timeout = 5000');

    // More frequent checkpoints
    db.run('PRAGMA wal_autocheckpoint = 100');

    // Note: cache_shared is not available in bun:sqlite
  }

  // Performance optimizations
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA synchronous = NORMAL'); // Safe with WAL
  db.run('PRAGMA cache_size = -4000'); // 4MB cache
  db.run('PRAGMA temp_store = MEMORY');
  db.run('PRAGMA mmap_size = 67108864'); // 64MB mmap

  // Query optimizer
  db.run('PRAGMA optimize');

  return db;
}

/**
 * Close database connection gracefully
 */
export function closeConnection(db: Database): void {
  try {
    // Checkpoint WAL before closing
    try {
      db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error: unknown) {
      console.warn('[db] WAL checkpoint failed:', error);
    }

    db.close();
  } catch (error: unknown) {
    console.error('[db] Error closing connection:', error);
  }
}

/**
 * Whitelist of allowed PRAGMA names to prevent SQL injection
 * via string interpolation in getPragmaValue.
 */
const ALLOWED_PRAGMAS = new Set([
  'journal_mode',
  'wal_autocheckpoint',
  'busy_timeout',
  'cache_size',
  'foreign_keys',
  'synchronous',
  'temp_store',
  'mmap_size',
  'page_size',
  'locking_mode',
  'page_count',
  'wal_checkpoint'
]);

/**
 * Helper to get a PRAGMA value
 */
function getPragmaValue(db: Database, pragma: string): unknown {
  if (!ALLOWED_PRAGMAS.has(pragma)) {
    throw new Error(
      `PRAGMA "${pragma}" is not allowed. Allowed PRAGMAs: ${[...ALLOWED_PRAGMAS].join(', ')}`
    );
  }
  const result = db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown>;
  return result ? Object.values(result)[0] : null;
}

/**
 * Check database health
 */
export function checkHealth(db: Database): {
  healthy: boolean;
  details: Record<string, unknown>;
} {
  try {
    // Simple query to verify database is accessible
    const result = db.query('SELECT 1 as health').get() as { health: number };

    const walInfo = db.query('PRAGMA wal_checkpoint').all();
    const pageCount = getPragmaValue(db, 'page_count') as number;
    const pageSize = getPragmaValue(db, 'page_size') as number;

    return {
      healthy: result.health === 1,
      details: {
        accessible: true,
        journalMode: getPragmaValue(db, 'journal_mode'),
        pageCount,
        pageSize,
        databaseSize: pageCount * pageSize,
        walInfo
      }
    };
  } catch (error: unknown) {
    return {
      healthy: false,
      details: {
        error: error instanceof Error ? error.message : String(error),
        accessible: false
      }
    };
  }
}

/**
 * Get database statistics
 */
export function getStats(db: Database): Record<string, unknown> {
  try {
    return {
      journalMode: getPragmaValue(db, 'journal_mode'),
      pageCount: getPragmaValue(db, 'page_count'),
      pageSize: getPragmaValue(db, 'page_size'),
      cacheSize: getPragmaValue(db, 'cache_size'),
      mmapSize: getPragmaValue(db, 'mmap_size'),
      walAutocheckpoint: getPragmaValue(db, 'wal_autocheckpoint'),
      synchronous: getPragmaValue(db, 'synchronous'),
      foreignKeys: getPragmaValue(db, 'foreign_keys')
    };
  } catch (error: unknown) {
    return {
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
