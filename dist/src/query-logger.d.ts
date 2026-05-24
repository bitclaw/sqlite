import type { Database } from 'bun:sqlite';
export type QueryLoggerOptions = {
    /** Label shown in log output, e.g. workspace ID or database name. */
    label?: string;
};
/**
 * Wrap a bun:sqlite Database with query logging.
 *
 * In development, every `query()`, `prepare()`, `run()`, and `exec()` call
 * logs the SQL to stdout in a format consistent with Prisma's `prisma:query`:
 *
 *   sqlite:query [label] SELECT * FROM servers WHERE id = ?
 *
 * In production, returns the database unchanged (zero overhead).
 *
 * Usage — always wrap, logging auto-enables in dev:
 *
 *   const db = wrapWithQueryLogging(new Database(path), { label: 'ws:abc123' });
 */
export declare function wrapWithQueryLogging<T extends Database>(db: T, options?: QueryLoggerOptions): T;
//# sourceMappingURL=query-logger.d.ts.map