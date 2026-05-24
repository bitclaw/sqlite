import type { Database } from 'bun:sqlite';
export type LockResult = {
    acquired: boolean;
    owner: string;
};
export declare class CacheLock {
    private readonly db;
    private readonly acquireStmt;
    private readonly checkOwnerStmt;
    private readonly releaseStmt;
    private readonly forceReleaseStmt;
    private readonly refreshStmt;
    private readonly isLockedStmt;
    private readonly pruneExpiredStmt;
    private readonly deleteExpiredStmt;
    constructor(db: Database);
    acquire(key: string, ttlMs: number, owner?: string): LockResult;
    release(key: string, owner: string): boolean;
    forceRelease(key: string): boolean;
    refresh(key: string, ttlMs: number, owner: string): boolean;
    isLocked(key: string): boolean;
    pruneExpired(): number;
    withLock<T>(key: string, ttlMs: number, fn: () => T | Promise<T>): Promise<T>;
}
//# sourceMappingURL=cache-lock.d.ts.map