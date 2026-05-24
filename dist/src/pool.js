// packages/sqlite/src/pool.ts
// SQLite Connection Pool with Worker Threads
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
// Use require.resolve to find worker.js from the package exports
// This works correctly in both development and when bundled
const require = createRequire(import.meta.url);
class SQLiteConnectionPool extends EventEmitter {
    workers = [];
    maxWorkers;
    workerTimeout;
    databasePath;
    pendingOperations = new Map();
    nextWorkerIndex = 0;
    isShuttingDown = false;
    metrics = {
        totalQueries: 0,
        activeQueries: 0,
        totalDuration: 0,
        errors: 0,
        workerStats: {}
    };
    constructor(config) {
        super();
        // Configuration from environment or config
        this.maxWorkers =
            config?.poolSize ??
                Number.parseInt(process.env.SQLITE_POOL_SIZE ?? '4', 10);
        this.workerTimeout =
            config?.timeout ??
                Number.parseInt(process.env.SQLITE_WORKER_TIMEOUT ?? '30000', 10);
        this.databasePath = config?.databasePath;
        this.initializePool();
    }
    initializePool() {
        // Resolve worker path from package exports - works in both dev and bundled production
        const workerPath = require.resolve('@bitclaw/sqlite/worker');
        for (let i = 0; i < this.maxWorkers; i += 1) {
            try {
                const worker = new Worker(workerPath, {
                    workerData: { databasePath: this.databasePath }
                });
                worker.on('message', this.handleWorkerMessage.bind(this));
                worker.on('error', this.handleWorkerError.bind(this));
                worker.on('exit', this.handleWorkerExit.bind(this, i));
                this.workers.push(worker);
            }
            catch (error) {
                console.error(`[pool] Failed to create worker ${i}:`, error);
                throw error;
            }
        }
    }
    handleWorkerMessage(response) {
        // Ignore shutdown responses
        if (response.id.startsWith('shutdown-')) {
            return;
        }
        const operation = this.pendingOperations.get(response.id);
        if (!operation) {
            console.warn(`[pool] Received response for unknown operation: ${response.id}`);
            return;
        }
        // Clear timeout
        clearTimeout(operation.timeout);
        this.pendingOperations.delete(response.id);
        // Update metrics
        this.metrics.activeQueries -= 1;
        const duration = Number(process.hrtime.bigint() - operation.startTime) / 1_000_000;
        this.metrics.totalDuration += duration;
        if (response.workerId) {
            if (!this.metrics.workerStats[response.workerId]) {
                this.metrics.workerStats[response.workerId] = {
                    queries: 0,
                    errors: 0,
                    totalDuration: 0
                };
            }
            const workerStat = this.metrics.workerStats[response.workerId];
            workerStat.queries += 1;
            workerStat.totalDuration += duration;
        }
        // Handle response
        if (response.success && !response.error) {
            operation.resolve(response.result);
        }
        else {
            this.metrics.errors += 1;
            if (response.workerId) {
                this.metrics.workerStats[response.workerId].errors += 1;
            }
            const error = Object.assign(new Error(response.error?.message || 'Unknown SQLite error'), { code: response.error?.code, errno: response.error?.errno });
            operation.reject(error);
        }
        // Emit metrics update
        this.emit('metrics', this.getMetrics());
    }
    handleWorkerError(error) {
        console.error('[pool] Worker error:', error);
        this.metrics.errors += 1;
        this.emit('error', error);
    }
    handleWorkerExit(workerIndex, code) {
        if (this.isShuttingDown)
            return;
        console.warn(`[pool] Worker ${workerIndex} exited with code ${code}`);
        this.emit('workerExit', { workerIndex, code });
    }
    /**
     * Execute SQL query with parameters
     */
    async exec(sql, params = []) {
        if (this.isShuttingDown) {
            throw new Error('Connection pool is shutting down');
        }
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        const startTime = process.hrtime.bigint();
        // Update metrics
        this.metrics.totalQueries += 1;
        this.metrics.activeQueries += 1;
        return new Promise((resolve, reject) => {
            // Set up timeout
            const timeout = setTimeout(() => {
                this.pendingOperations.delete(id);
                this.metrics.activeQueries -= 1;
                this.metrics.errors += 1;
                reject(new Error(`SQLite operation timed out after ${this.workerTimeout}ms`));
            }, this.workerTimeout);
            // Store operation (cast resolve since the map is non-generic)
            this.pendingOperations.set(id, {
                resolve: resolve,
                reject,
                timeout,
                sql,
                startTime
            });
            // Send to worker using round-robin
            const worker = this.workers[this.nextWorkerIndex];
            this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workers.length;
            const message = { id, sql, params };
            worker.postMessage(message);
        });
    }
    /**
     * Execute operations on a specific worker (for transactions)
     */
    async execOnWorker(workerIndex, sql, params = []) {
        if (this.isShuttingDown) {
            throw new Error('Connection pool is shutting down');
        }
        if (workerIndex >= this.workers.length) {
            throw new Error(`Invalid worker index: ${workerIndex}`);
        }
        const id = `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
        const startTime = process.hrtime.bigint();
        // Update metrics
        this.metrics.totalQueries += 1;
        this.metrics.activeQueries += 1;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingOperations.delete(id);
                this.metrics.activeQueries -= 1;
                this.metrics.errors += 1;
                reject(new Error(`SQLite operation timed out after ${this.workerTimeout}ms`));
            }, this.workerTimeout);
            this.pendingOperations.set(id, {
                resolve: resolve,
                reject,
                timeout,
                sql,
                startTime
            });
            // Send to specific worker
            const worker = this.workers[workerIndex];
            const message = { id, sql, params };
            worker.postMessage(message);
        });
    }
    /**
     * Get current pool metrics
     */
    getMetrics() {
        return {
            ...this.metrics,
            workerStats: { ...this.metrics.workerStats }
        };
    }
    /**
     * Get pool status for health checks
     */
    getStatus() {
        return {
            workers: this.workers.length,
            activeQueries: this.metrics.activeQueries,
            isShuttingDown: this.isShuttingDown,
            totalQueries: this.metrics.totalQueries,
            errorRate: this.metrics.totalQueries > 0
                ? (this.metrics.errors / this.metrics.totalQueries) * 100
                : 0,
            avgDuration: this.metrics.totalQueries > 0
                ? this.metrics.totalDuration / this.metrics.totalQueries
                : 0
        };
    }
    /**
     * Graceful shutdown of the connection pool
     */
    async shutdown(timeoutMs = 5000) {
        if (this.isShuttingDown)
            return;
        this.isShuttingDown = true;
        // Wait for pending operations
        const startTime = Date.now();
        const checkPending = () => this.pendingOperations.size === 0;
        while (!checkPending() && Date.now() - startTime < timeoutMs) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Send shutdown messages to workers
        for (let i = 0; i < this.workers.length; i++) {
            const worker = this.workers[i];
            if (worker) {
                const shutdownMessage = {
                    id: `shutdown-${Date.now()}-${i}`,
                    sql: '__SHUTDOWN__',
                    params: []
                };
                try {
                    worker.postMessage(shutdownMessage);
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await worker.terminate();
                }
                catch (error) {
                    console.warn(`[pool] Error shutting down worker ${i}:`, error);
                    await worker.terminate();
                }
            }
        }
        this.workers = [];
        this.nextWorkerIndex = 0;
        this.pendingOperations.clear();
    }
}
// Singleton instance
let pool = null;
/**
 * Create a new connection pool instance
 */
export function createPool(config) {
    if (pool) {
        throw new Error('Pool already exists. Call getPool() to retrieve it or shutdown() first.');
    }
    pool = new SQLiteConnectionPool(config);
    return pool;
}
/**
 * Get the singleton connection pool instance
 */
export function getPool() {
    if (!pool) {
        pool = new SQLiteConnectionPool();
    }
    return pool;
}
/**
 * Execute SQL query using the connection pool
 */
export async function exec(sql, params = []) {
    return getPool().exec(sql, params);
}
/**
 * Get pool metrics for monitoring
 */
export function getPoolMetrics() {
    return getPool().getMetrics();
}
/**
 * Get pool status for health checks
 */
export function getPoolStatus() {
    return getPool().getStatus();
}
/**
 * Shutdown the connection pool
 */
export async function shutdownPool(timeoutMs) {
    if (pool) {
        if (!pool.getStatus().isShuttingDown) {
            try {
                await exec('PRAGMA wal_checkpoint(TRUNCATE)');
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.warn('[pool] WAL checkpoint skipped:', errorMessage);
            }
        }
        await pool.shutdown(timeoutMs);
        pool = null;
    }
}
/**
 * Execute multiple operations atomically on a single worker
 */
export async function withTransaction(operation) {
    // Use first worker for all transaction operations
    const workerIndex = 0;
    const poolInstance = getPool();
    // Create a transaction-scoped execute function
    const executeInTransaction = async (sql, params = []) => {
        return poolInstance.execOnWorker(workerIndex, sql, params);
    };
    let success = false;
    try {
        await executeInTransaction('BEGIN IMMEDIATE');
        const result = await operation(executeInTransaction);
        await executeInTransaction('COMMIT');
        success = true;
        return result;
    }
    catch (error) {
        if (!success) {
            try {
                await executeInTransaction('ROLLBACK');
            }
            catch (rollbackError) {
                console.error('[tx] Rollback failed:', rollbackError);
            }
        }
        throw error;
    }
}
