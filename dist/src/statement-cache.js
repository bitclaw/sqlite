export class StatementCache {
    cache = new Map();
    maxSize;
    hits = 0;
    misses = 0;
    constructor(options) {
        this.maxSize = options?.maxSize ?? 256;
    }
    getOrPrepare(db, sql) {
        const normalized = sql.trim().replace(/\s+/g, ' ');
        const cached = this.get(normalized);
        if (cached)
            return cached;
        const stmt = db.query(normalized);
        this.set(normalized, stmt);
        return stmt;
    }
    get(sql) {
        const stmt = this.cache.get(sql);
        if (stmt) {
            this.hits += 1;
            this.cache.delete(sql);
            this.cache.set(sql, stmt);
            return stmt;
        }
        return null;
    }
    set(sql, stmt) {
        this.misses += 1;
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
