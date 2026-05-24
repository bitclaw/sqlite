// packages/sqlite/src/worker.ts
// SQLite Worker Thread - Optimized for Hetzner VPS deployment
// Uses bun:sqlite for 3-6x faster reads compared to better-sqlite3
import { Database } from 'bun:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
const isDevelopment = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';
// ---------------------------------------------------------------------------
// Prepared-statement LRU cache for optimal performance
// ---------------------------------------------------------------------------
class StatementCache {
    cache = new Map();
    maxSize = 256;
    hits = 0;
    misses = 0;
    get(sql) {
        const stmt = this.cache.get(sql);
        if (stmt) {
            this.hits += 1;
            // Move to end (LRU behavior)
            this.cache.delete(sql);
            this.cache.set(sql, stmt);
            return stmt;
        }
        return null;
    }
    set(sql, stmt) {
        this.misses += 1;
        // If at capacity, remove oldest
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            if (firstKey) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(sql, stmt);
    }
    getStats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            size: this.cache.size,
            hitRate: total > 0 ? (this.hits / total) * 100 : 0
        };
    }
    clear() {
        this.cache.clear();
        this.hits = 0;
        this.misses = 0;
    }
}
const stmtCache = new StatementCache();
// Worker-specific database configuration
async function getDbConfig() {
    const envPath = workerData?.databasePath ??
        process.env.DATABASE_PATH;
    if (envPath) {
        return {
            path: envPath,
            options: {
                verbose: undefined,
                fileMustExist: false
            }
        };
    }
    if (isTest) {
        return {
            path: ':memory:',
            options: {
                verbose: undefined,
                fileMustExist: false
            }
        };
    }
    if (isDevelopment) {
        return {
            path: './data/app.db',
            options: {
                verbose: undefined,
                fileMustExist: false
            }
        };
    }
    // Production
    return {
        path: '/data/app.db',
        options: { verbose: undefined, fileMustExist: false }
    };
}
function getOrCreateStatement(db, sql) {
    // Normalize SQL for better cache hits
    const normalizedSql = sql.trim().replace(/\s+/g, ' ');
    let stmt = stmtCache.get(normalizedSql);
    if (stmt) {
        return stmt;
    }
    // Cache miss → prepare + insert (bun:sqlite uses .query() instead of .prepare())
    stmt = db.query(normalizedSql);
    stmtCache.set(normalizedSql, stmt);
    return stmt;
}
// SQLite Worker class
export class SQLiteWorker {
    db = null;
    config;
    workerId;
    constructor(config) {
        this.config = config;
        this.workerId = `worker-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    }
    async initializeDatabase() {
        if (this.db)
            return;
        // Get config if not provided
        if (!this.config) {
            this.config = await getDbConfig();
        }
        try {
            // bun:sqlite constructor options differ from better-sqlite3
            this.db = new Database(this.config.path, {
                create: !this.config.options.fileMustExist,
                readonly: false
            });
            // ✅ OPTIMIZED: Enhanced multi-worker SQLite configuration
            // bun:sqlite uses run() for PRAGMA statements instead of pragma()
            if (this.config.path !== ':memory:') {
                // WAL mode with optimized settings
                this.db.run('PRAGMA journal_mode = WAL');
                // ✅ CRITICAL: Reduced timeout for better worker coordination
                this.db.run('PRAGMA busy_timeout = 5000');
                // ✅ PERFORMANCE: More frequent checkpoints for multi-worker
                this.db.run('PRAGMA wal_autocheckpoint = 100');
                // ✅ CONCURRENCY: Enable shared cache for same-process workers
                // Note: cache_shared is not available in bun:sqlite, skip it
            }
            // ✅ PERFORMANCE: Optimized PRAGMA settings for workers
            this.db.run('PRAGMA foreign_keys = ON');
            this.db.run('PRAGMA synchronous = NORMAL'); // Optimal for WAL mode
            // ✅ MEMORY: 4MB per worker cache
            this.db.run('PRAGMA cache_size = -4000');
            this.db.run('PRAGMA temp_store = MEMORY');
            // ✅ CONCURRENCY: Optimized mmap for multi-worker
            this.db.run('PRAGMA mmap_size = 67108864'); // 64MB
            // ✅ PERFORMANCE: Enable query planner optimizations
            this.db.run('PRAGMA optimize');
        }
        catch (error) {
            console.error(`[${this.workerId}] Failed to initialize database:`, error);
            throw error;
        }
    }
    async handleMessage(message) {
        const start = performance.now();
        let success = false;
        let result;
        let error;
        try {
            if (message.sql === '__SHUTDOWN__') {
                this.shutdown();
                return {
                    id: message.id,
                    result: { shutdown: true },
                    workerId: this.workerId,
                    durationMs: performance.now() - start,
                    success: true
                };
            }
            // Lazy initialization
            if (!this.db) {
                await this.initializeDatabase();
            }
            result = this.executeQuery(message.sql, message.params || []);
            success = true;
        }
        catch (err) {
            // err (not error) to avoid shadowing the outer `error` return variable
            const e = err instanceof Error ? err : new Error(String(err));
            error = {
                message: e.message,
                code: e.code,
                errno: e.errno
            };
        }
        return {
            id: message.id,
            result,
            error,
            workerId: this.workerId,
            durationMs: performance.now() - start,
            success
        };
    }
    executeQuery(sql, params) {
        if (!this.db) {
            throw new Error('Database not initialized');
        }
        const sqlUpper = sql.trim().toUpperCase();
        try {
            const stmt = getOrCreateStatement(this.db, sql);
            let result;
            if (sqlUpper.startsWith('SELECT')) {
                if (sqlUpper.includes('LIMIT 1') || sqlUpper.includes('COUNT(*)')) {
                    // bun:sqlite uses .get() with params directly
                    result = stmt.get(...params);
                }
                else {
                    result = stmt.all(...params);
                }
            }
            else if (sqlUpper.startsWith('INSERT') ||
                sqlUpper.startsWith('UPDATE') ||
                sqlUpper.startsWith('DELETE')) {
                // bun:sqlite .run() returns { changes, lastInsertRowid }
                const runResult = stmt.run(...params);
                result = {
                    changes: runResult.changes,
                    lastInsertRowid: runResult.lastInsertRowid
                };
            }
            else {
                this.db.run(sql);
                result = { success: true };
            }
            return result;
        }
        catch (error) {
            const e = error instanceof Error ? error : new Error(String(error));
            console.error(`[${this.workerId}] SQL FAILED:`, {
                sql: `${sql.substring(0, 60)}...`,
                error: e.message,
                code: e.code,
                errno: e.errno,
                params: params?.length || 0
            });
            throw error;
        }
    }
    shutdown() {
        if (this.db) {
            try {
                // Clear prepared statement cache
                stmtCache.clear();
                this.db.close();
                this.db = null;
            }
            catch (error) {
                console.error(`[${this.workerId}] Error during shutdown:`, error);
            }
        }
    }
    getWorkerId() {
        return this.workerId;
    }
}
// Worker thread main execution
if (parentPort) {
    const worker = new SQLiteWorker();
    parentPort.on('message', async (message) => {
        try {
            if (!message.id) {
                console.error(`[${worker.getWorkerId()}] CRITICAL: Message missing ID:`, message);
                parentPort?.postMessage({
                    id: 'unknown',
                    error: { message: 'Message missing ID' },
                    workerId: worker.getWorkerId(),
                    durationMs: 0,
                    success: false
                });
                return;
            }
            const response = await worker.handleMessage(message);
            if (!response.id) {
                console.error(`[${worker.getWorkerId()}] CRITICAL: Response missing ID:`, response);
                response.id = message.id;
            }
            parentPort?.postMessage(response);
        }
        catch (error) {
            const e = error instanceof Error ? error : new Error(String(error));
            parentPort?.postMessage({
                id: message.id || 'unknown',
                error: {
                    message: e.message,
                    code: e.code,
                    errno: e.errno
                },
                workerId: worker.getWorkerId(),
                durationMs: 0,
                success: false
            });
        }
    });
}
