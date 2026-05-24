# @bitclaw/sqlite

High-performance SQLite optimization package for multi-app SaaS deployments.

## Features

- **Worker Thread Pool**: Multiple SQLite connections for concurrent read/write operations
- **Statement Caching**: Automatic prepared statement caching per worker
- **Write Concurrency**: Per-resource write mutex and retry with exponential backoff
- **Prisma Integration**: BEGIN IMMEDIATE transaction wrapper for Prisma + libsql
- **JSON File Cache**: levelsio-style file-based caching with TTL support
- **Zero External Dependencies**: Uses bun:sqlite (built into the Bun runtime)
- **TypeScript**: Full type safety and IDE autocomplete

## Modules

| Import | Purpose |
|--------|---------|
| `@bitclaw/sqlite/pool` | Worker thread pool for concurrent SQLite operations |
| `@bitclaw/sqlite/connection` | Single connection with optimized PRAGMAs |
| `@bitclaw/sqlite/json-cache` | File-based JSON cache with TTL |
| `@bitclaw/sqlite/write-mutex` | Promise-based per-resource write mutex |
| `@bitclaw/sqlite/retry` | Exponential backoff retry for SQLITE_BUSY errors |
| `@bitclaw/sqlite/prisma-immediate-tx` | BEGIN IMMEDIATE wrapper for Prisma transactions |
| `@bitclaw/sqlite/query-logger` | Dev-mode SQL logging for bun:sqlite (mirrors Prisma's `prisma:query`) |
| `@bitclaw/sqlite/ttl-cache` | In-memory TTL cache for server-side deduplication across HTTP requests |

## Performance

### Pool-Level Benchmarks (raw `pool.exec()`)

Based on benchmarks from SecureLogin project:

- **6,102 - 13,781 req/s** on Hetzner CPX21 (3 vCPU, 4GB RAM)
- **P95 latency**: 12-22ms
- **100% success rate** under load
- **Prepared statement cache hit rate**: 100%

These numbers reflect **direct SQLite pool operations** — no HTTP server, no ORM, no middleware. Application-level throughput (through TanStack Start + Prisma + SSR) will be lower. Use `bun run test:load` in each app for end-to-end numbers.

## Benchmarking Methodology

### Pool-Level (`scripts/benchmark.ts`)

Tests raw `pool.exec()` calls against an in-process SQLite database:

- Creates a temporary database with a `users` table
- Runs concurrent workers executing `SELECT COUNT(*)` (reads) and `INSERT` (writes)
- Measures latency per operation, calculates P50/P95/P99
- No HTTP, no ORM, no serialization overhead

This represents the **theoretical ceiling** for SQLite throughput on given hardware.

### Application-Level (`bun run test:load`)

Tests end-to-end HTTP throughput through the full stack:

- Uses native `fetch()` against a running application server
- Measures real response times including: HTTP parsing, middleware, Prisma ORM, SSR rendering, serialization
- Tests at multiple concurrency levels (10/50/100)
- Reports req/s, P50/P95/P99 latency, success rate

This represents **actual user-facing performance**.

## Installation

```bash
bun add @bitclaw/sqlite
```

## Usage

### Worker Pool

```typescript
import { createPool } from '@bitclaw/sqlite/pool';

const pool = createPool({
  databasePath: './data/app.db',
  poolSize: 4,
  timeout: 30000
});

// Execute query
const users = await pool.exec('SELECT * FROM users WHERE id = ?', [userId]);

// Graceful shutdown
await pool.shutdown();
```

### Write Mutex

Serialize writes per resource to prevent SQLITE_BUSY contention before it reaches SQLite:

```typescript
import { WriteMutex, WriteMutexMap } from '@bitclaw/sqlite/write-mutex';

// Single mutex
const mutex = new WriteMutex();
const result = await mutex.acquire(() => db.run('INSERT INTO ...'));

// Named mutexes (e.g. per-tenant)
const mutexes = new WriteMutexMap();
await mutexes.withLock('workspace-123', () => db.run('INSERT INTO ...'));
```

### Retry with Backoff

Retry operations that fail with SQLITE_BUSY using exponential backoff + jitter:

```typescript
import { withRetry } from '@bitclaw/sqlite/retry';

const result = await withRetry(
  () => db.run('INSERT INTO ...'),
  { maxAttempts: 3, baseDelayMs: 100 }
);
```

### Prisma BEGIN IMMEDIATE

Prevent SQLITE_BUSY from Prisma's default deferred transactions:

```typescript
import { immediateTransaction } from '@bitclaw/sqlite/prisma-immediate-tx';
import { withRetry } from '@bitclaw/sqlite/retry';

await withRetry(() =>
  immediateTransaction(prisma, async () => {
    await prisma.user.create({ data: { ... } });
    await prisma.session.update({ where: { ... }, data: { ... } });
  })
);
```

### JSON Cache

```typescript
import { createJsonCache } from '@bitclaw/sqlite/json-cache';

const cache = createJsonCache({
  cacheDir: './cache',
  defaultTtl: 300000 // 5 minutes
});

// Set value
await cache.set('user:123', userData, { ttl: 600000 });

// Get value
const user = await cache.get('user:123');

// Delete value
await cache.delete('user:123');
```

### Query Logger

Dev-mode SQL logging for bun:sqlite — mirrors Prisma's `prisma:query` output. Zero overhead in production.

```typescript
import { Database } from 'bun:sqlite';
import { wrapWithQueryLogging } from '@bitclaw/sqlite/query-logger';

const raw = new Database('./data/workspace.db');
const db = wrapWithQueryLogging(raw, { label: 'ws:abc123' });

// In development, every query/prepare/run/exec logs to stdout:
//   sqlite:query [ws:abc123] SELECT * FROM servers WHERE id = ?
//
// In production (NODE_ENV !== 'development'), returns the database unchanged.
db.query('SELECT * FROM servers WHERE id = ?').get(serverId);
```

### TTL Cache

In-memory TTL cache for server-side deduplication across HTTP requests. Designed for caching expensive lookups (auth sessions, membership checks, bootstrap data) that repeat when frameworks like TanStack Router re-run loaders on client hydration.

```typescript
import { TTLCache } from '@bitclaw/sqlite/ttl-cache';

type BootstrapData = { user: User; workspaces: Workspace[] };

const bootstrapCache = new TTLCache<BootstrapData>({
  ttl: 30_000,   // 30s (default)
  maxSize: 100   // auto-prune expired entries when exceeded (default)
});

// In your server function:
const cached = bootstrapCache.get(sessionId);
if (cached) return cached;

const data = await expensiveQuery();
bootstrapCache.set(sessionId, data);
return data;
```

Unlike `WeakMap` per-request caching (which deduplicates within a single SSR request), `TTLCache` deduplicates **across** HTTP requests — e.g. when TanStack Router replays `beforeLoad` on client hydration, the server returns the cached result instantly (0 DB queries).

## Configuration

### Environment Variables

```bash
SQLITE_POOL_SIZE=4              # Number of worker threads
SQLITE_WORKER_TIMEOUT=30000     # Query timeout in milliseconds
DATABASE_PATH=./data/app.db     # Database file path
JSON_CACHE_DIR=./cache          # Cache directory
JSON_CACHE_TTL=300000           # Default TTL in milliseconds
```

## Benchmarking

```bash
# Quick benchmark (5 seconds, default)
bun run benchmark

# Quick benchmark (explicit)
bun run benchmark:quick

# CPX21 tier benchmark (matches production)
bun run benchmark -- --tier cpx21

# All Hetzner tiers
bun run benchmark -- --tiers

# Help
bun run benchmark -- --help
```

## Architecture

### Worker Pool
- Uses Node.js worker threads for true concurrency
- Round-robin query distribution
- Automatic connection health monitoring
- Graceful shutdown with connection cleanup

### Write Concurrency
- **Write Mutex**: Promise-based per-resource lock serializes writes before they hit SQLite, eliminating contention at near-zero overhead
- **Retry**: Exponential backoff with jitter catches any remaining SQLITE_BUSY errors as a safety net (default: 3 attempts, 100ms base delay)
- **BEGIN IMMEDIATE**: Prisma wrapper acquires write lock upfront instead of deferring, preventing the deadlock-prone lock upgrade path

### JSON Cache
- Atomic writes using temp files
- TTL-based expiration
- Stale-while-revalidate support
- No external dependencies

## License

MIT
