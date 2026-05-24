import { EventEmitter } from 'node:events';
export type PoolMetrics = {
    totalQueries: number;
    activeQueries: number;
    totalDuration: number;
    errors: number;
    workerStats: {
        [workerId: string]: {
            queries: number;
            errors: number;
            totalDuration: number;
        };
    };
};
export type PoolConfig = {
    databasePath?: string;
    poolSize?: number;
    timeout?: number;
};
declare class SQLiteConnectionPool extends EventEmitter {
    private workers;
    private maxWorkers;
    private workerTimeout;
    private databasePath;
    private pendingOperations;
    private nextWorkerIndex;
    private isShuttingDown;
    private metrics;
    constructor(config?: PoolConfig);
    private initializePool;
    private handleWorkerMessage;
    private handleWorkerError;
    private handleWorkerExit;
    /**
     * Execute SQL query with parameters
     */
    exec<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
    /**
     * Execute operations on a specific worker (for transactions)
     */
    execOnWorker<T = unknown>(workerIndex: number, sql: string, params?: unknown[]): Promise<T>;
    /**
     * Get current pool metrics
     */
    getMetrics(): PoolMetrics;
    /**
     * Get pool status for health checks
     */
    getStatus(): {
        workers: number;
        activeQueries: number;
        isShuttingDown: boolean;
        totalQueries: number;
        errorRate: number;
        avgDuration: number;
    };
    /**
     * Graceful shutdown of the connection pool
     */
    shutdown(timeoutMs?: number): Promise<void>;
}
/**
 * Create a new connection pool instance
 */
export declare function createPool(config?: PoolConfig): SQLiteConnectionPool;
/**
 * Get the singleton connection pool instance
 */
export declare function getPool(): SQLiteConnectionPool;
/**
 * Execute SQL query using the connection pool
 */
export declare function exec<T = unknown>(sql: string, params?: unknown[]): Promise<T>;
/**
 * Get pool metrics for monitoring
 */
export declare function getPoolMetrics(): PoolMetrics;
/**
 * Get pool status for health checks
 */
export declare function getPoolStatus(): {
    workers: number;
    activeQueries: number;
    isShuttingDown: boolean;
    totalQueries: number;
    errorRate: number;
    avgDuration: number;
};
/**
 * Shutdown the connection pool
 */
export declare function shutdownPool(timeoutMs?: number): Promise<void>;
/**
 * Execute multiple operations atomically on a single worker
 */
export declare function withTransaction<T>(operation: (execute: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=pool.d.ts.map