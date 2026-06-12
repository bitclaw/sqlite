import { Database } from 'bun:sqlite';
export type TenantDbConfig = {
    maxConnections?: number;
    idleTimeoutMs?: number;
    cleanupIntervalMs?: number;
    onOpen?: (db: Database, tenantId: string) => void;
    wrapDb?: (raw: Database, tenantId: string) => Database;
};
export type TenantDbManager = {
    getDb: (tenantId: string, dbPath: string) => Database;
    withWriteLock: <T>(tenantId: string, fn: () => T | Promise<T>) => Promise<T>;
    evict: (tenantId: string) => void;
    evictIdle: (maxIdleMs?: number) => number;
    closeAll: () => void;
    getStats: () => {
        activeConnections: number;
        oldestAccess: number | null;
    };
};
export declare const createTenantDbManager: (config?: TenantDbConfig) => TenantDbManager;
//# sourceMappingURL=tenant-db.d.ts.map