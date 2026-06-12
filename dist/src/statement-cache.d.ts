import type { Database, Statement } from 'bun:sqlite';
type CachedStatement = Statement<unknown>;
export declare class StatementCache {
    private cache;
    private maxSize;
    private hits;
    private misses;
    constructor(options?: {
        maxSize?: number;
    });
    getOrPrepare(db: Database, sql: string): CachedStatement;
    get(sql: string): CachedStatement | null;
    set(sql: string, stmt: CachedStatement): void;
    getStats(): {
        hits: number;
        misses: number;
        size: number;
        hitRate: number;
    };
    clear(): void;
}
export {};
//# sourceMappingURL=statement-cache.d.ts.map