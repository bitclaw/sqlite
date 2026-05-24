// packages/sqlite/src/query-logger.ts
// Dev-mode query logging for bun:sqlite — mirrors Prisma's `prisma:query` output.
// Wraps a Database with a transparent Proxy that logs SQL on query/run/exec/prepare.
// Zero overhead in production: returns the database as-is when NODE_ENV !== 'development'.
// biome-ignore lint/suspicious/noConsole: intentional dev-mode query logging (mirrors Prisma's log: ['query'])
const log = console.log;
const isDev = process.env.NODE_ENV === 'development';
// ANSI green for the prefix — contrasts with Prisma's blue `prisma:query`
const GREEN = '\x1b[32m';
const RESET = '\x1b[0m';
const formatSql = (sql) => sql.replace(/\s+/g, ' ').trim();
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
export function wrapWithQueryLogging(db, options = {}) {
    if (!isDev)
        return db;
    const { label } = options;
    const prefix = label
        ? `${GREEN}sqlite:query${RESET} [${label}]`
        : `${GREEN}sqlite:query${RESET}`;
    return new Proxy(db, {
        get(target, prop, receiver) {
            const value = Reflect.get(target, prop, receiver);
            if (typeof value !== 'function')
                return value;
            if (prop === 'query' || prop === 'prepare') {
                return (sql) => {
                    log(`${prefix} ${formatSql(sql)}`);
                    return value.call(target, sql);
                };
            }
            if (prop === 'run') {
                return (sql, ...params) => {
                    log(`${prefix} ${formatSql(sql)}`);
                    return value.call(target, sql, ...params);
                };
            }
            if (prop === 'exec') {
                return (sql) => {
                    log(`${prefix} ${formatSql(sql)}`);
                    return value.call(target, sql);
                };
            }
            // Bind all other methods to the real target
            return value.bind(target);
        }
    });
}
