import { Database } from 'bun:sqlite';
export type ConnectionConfig = {
    path: string;
    readonly?: boolean;
    verbose?: boolean;
};
/**
 * Initialize a SQLite database with optimal settings
 */
export declare function initializeConnection(config: ConnectionConfig): Database;
/**
 * Close database connection gracefully
 */
export declare function closeConnection(db: Database): void;
/**
 * Check database health
 */
export declare function checkHealth(db: Database): {
    healthy: boolean;
    details: Record<string, unknown>;
};
/**
 * Get database statistics
 */
export declare function getStats(db: Database): Record<string, unknown>;
//# sourceMappingURL=connection.d.ts.map