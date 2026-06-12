import type { Database, Statement } from 'bun:sqlite';

// Statement type alias (dynamic SQL — row shape unknown, params accept any binding)
type CachedStatement = Statement<unknown>;

export class StatementCache {
  private cache = new Map<string, CachedStatement>();
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(options?: { maxSize?: number }) {
    this.maxSize = options?.maxSize ?? 256;
  }

  getOrPrepare(db: Database, sql: string): CachedStatement {
    const normalized = sql.trim().replace(/\s+/g, ' ');
    const cached = this.get(normalized);
    if (cached) return cached;
    const stmt = db.query(normalized);
    this.set(normalized, stmt);
    return stmt;
  }

  get(sql: string): CachedStatement | null {
    const stmt = this.cache.get(sql);
    if (stmt) {
      this.hits += 1;
      this.cache.delete(sql);
      this.cache.set(sql, stmt);
      return stmt;
    }
    return null;
  }

  set(sql: string, stmt: CachedStatement): void {
    this.misses += 1;
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(sql, stmt);
  }

  getStats(): { hits: number; misses: number; size: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      hitRate: total > 0 ? (this.hits / total) * 100 : 0
    };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
