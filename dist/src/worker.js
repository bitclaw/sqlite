// packages/sqlite/src/worker.ts
// SQLite Worker Thread - Optimized for Hetzner VPS deployment
// Uses bun:sqlite for 3-6x faster reads compared to better-sqlite3
import { Database } from 'bun:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { StatementCache } from './statement-cache';
import { setWalModeWithRetry } from './wal-mode';
const isDevelopment = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';
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
    return stmtCache.getOrPrepare(db, sql);
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
            if (this.config.path !== ':memory:') {
                // busy_timeout first: correct for ordinary statement contention (see
                // wal-mode.ts for why the WAL switch itself needs its own retry).
                this.db.run('PRAGMA busy_timeout = 10000');
                setWalModeWithRetry(this.db);
            }
            this.db.run('PRAGMA foreign_keys = ON');
            this.db.run('PRAGMA synchronous = NORMAL');
            this.db.run('PRAGMA cache_size = -20000'); // 20MB cache
            this.db.run('PRAGMA temp_store = MEMORY');
            this.db.run('PRAGMA mmap_size = 268435456'); // 256MB mmap
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
