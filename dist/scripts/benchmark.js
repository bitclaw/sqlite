#!/usr/bin/env bun
// packages/sqlite/scripts/benchmark.ts
// SQLite performance benchmark for Hetzner VPS tiers
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPool, shutdownPool } from '../src/pool';
/* ------------------------------------------------------------------
 * Hetzner VPS Tiers (vs AWS Lambda)
 * ------------------------------------------------------------------ */
const HETZNER_TIERS = [
    { name: 'CPX11', vcpu: 2, ram: 2048, pool: 2, monthly: 4.15 }, // Entry
    { name: 'CPX21', vcpu: 3, ram: 4096, pool: 4, monthly: 7.49 }, // DEFAULT
    { name: 'CPX31', vcpu: 4, ram: 8192, pool: 4, monthly: 15.49 }, // Mid
    { name: 'CPX41', vcpu: 8, ram: 16384, pool: 6, monthly: 30.99 } // High
];
/* ------------------------------------------------------------------
 * Performance Targets
 * ------------------------------------------------------------------ */
const TARGETS = {
    p95LatencyMs: 40,
    errorRatePct: 0.5,
    throughputQps: 1000
};
/* ------------------------------------------------------------------
 * Helper utilities
 * ------------------------------------------------------------------ */
function percentile(sorted, p) {
    if (!sorted.length)
        return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}
/* ------------------------------------------------------------------
 * Benchmark runner class
 * ------------------------------------------------------------------ */
class PoolBench {
    results = [];
    failCount = 0;
    async run(cfg) {
        this.failCount = 0;
        await PoolBench.initDatabase();
        const pool = createPool({
            databasePath: process.env.DATABASE_PATH,
            poolSize: cfg.poolSize,
            timeout: 30000
        });
        const lat = [];
        const t0 = performance.now();
        const end = t0 + cfg.durationSec * 1_000;
        // Create concurrent workers
        const workers = Array.from({ length: cfg.concurrency }, () => PoolBench.workerLoop(cfg.op, pool.exec.bind(pool), end, lat, this));
        await Promise.allSettled(workers);
        const durSec = (performance.now() - t0) / 1_000;
        lat.sort((a, b) => a - b);
        const total = lat.length;
        const fail = this.failCount;
        const ok = total - fail;
        const r = {
            op: cfg.op,
            pool: cfg.poolSize,
            tierName: cfg.tierName,
            tierCost: cfg.tierCost,
            total,
            ok,
            fail,
            errPct: total ? (fail / total) * 100 : 0,
            tput: total / durSec,
            p50: percentile(lat, 50),
            p95: percentile(lat, 95),
            p99: percentile(lat, 99),
            max: lat.at(-1) ?? 0,
            min: lat[0] ?? 0
        };
        this.results.push(r);
        await PoolBench.cleanupPool();
    }
    static async initDatabase() {
        // Ensure data/ directory exists
        const dataDir = path.resolve(import.meta.dir, '..', 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        const pid = process.pid;
        const dbFile = path.join(dataDir, `bench-${timestamp}-${pid}-${random}.db`);
        process.env.DATABASE_PATH = dbFile;
        // Clean up old test files
        for (const ext of ['', '-shm', '-wal']) {
            const file = dbFile + ext;
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        // Create test table using bun:sqlite
        const { Database } = await import('bun:sqlite');
        const testDb = new Database(dbFile);
        try {
            // Pre-set WAL mode so pool workers don't race to set it
            testDb.run('PRAGMA journal_mode = WAL');
            testDb.run('PRAGMA busy_timeout = 5000');
            testDb.run(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          primary_email TEXT NOT NULL UNIQUE,
          name TEXT,
          max_sessions INTEGER DEFAULT 5,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_users_email ON users(primary_email);
      `);
        }
        catch (error) {
            console.error('[db] CRITICAL: Tables not found:', error);
            throw new Error('Migration verification failed');
        }
        finally {
            testDb.close();
        }
        // Give the OS time to release the file lock after close
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    static async cleanupPool() {
        try {
            // shutdownPool can hang if workers are stuck; add a timeout
            await Promise.race([
                shutdownPool(),
                new Promise(resolve => setTimeout(resolve, 5000))
            ]);
        }
        finally {
            const dbPath = process.env.DATABASE_PATH;
            if (dbPath && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 200));
                    for (const ext of ['', '-shm', '-wal']) {
                        const file = dbPath + ext;
                        if (fs.existsSync(file)) {
                            fs.unlinkSync(file);
                        }
                    }
                }
                catch (error) {
                    console.warn(`Warning: Could not clean up ${dbPath}:`, error);
                }
            }
            delete process.env.DATABASE_PATH;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    static async workerLoop(op, exec, endTs, lat, benchInstance) {
        let localFailCount = 0;
        while (performance.now() < endTs) {
            const start = performance.now();
            try {
                await PoolBench.doOne(op, exec);
            }
            catch (error) {
                localFailCount += 1;
                benchInstance.failCount += 1;
                if (localFailCount <= 3) {
                    console.error(`Worker failure ${localFailCount}:`, error instanceof Error ? error.message : String(error));
                }
            }
            finally {
                lat.push(performance.now() - start);
            }
            await new Promise(res => setTimeout(res, 1));
        }
    }
    static async doOne(op, exec) {
        const id = `u-${Math.random().toString(36).slice(2)}`;
        const email = `${id}@bench.test`;
        switch (op) {
            case 'read':
                return exec('SELECT COUNT(*) as c FROM users;');
            case 'write':
                return exec(`INSERT INTO users (id, primary_email, max_sessions, created_at, updated_at)
           VALUES (?, ?, 5, ?, ?)`, [id, email, new Date().toISOString(), new Date().toISOString()]);
            default: // mixed
                return Math.random() < 0.7
                    ? exec('SELECT COUNT(*) as c FROM users;')
                    : exec(`INSERT INTO users (id, primary_email, max_sessions, created_at, updated_at)
             VALUES (?, ?, 5, ?, ?)`, [id, email, new Date().toISOString(), new Date().toISOString()]);
        }
    }
    print() {
        console.info('\n═══════════════════════════════════════════════════════');
        console.info('  SQLite Pool Benchmark Results');
        console.info('═══════════════════════════════════════════════════════\n');
        for (const r of this.results) {
            const tierText = r.tierName ? `  tier=${r.tierName}` : '';
            const costText = r.tierCost ? ` (€${r.tierCost}/mo)` : '';
            console.info(`  op=${r.op}  pool=${r.pool}${tierText}${costText}`);
            console.info(`  total=${r.total}  ok=${r.ok}  fail=${r.fail}  err=${r.errPct.toFixed(2)}%`);
            console.info(`  throughput=${r.tput.toFixed(0)} qps`);
            console.info(`  latency: p50=${r.p50.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms  p99=${r.p99.toFixed(1)}ms  max=${r.max.toFixed(1)}ms`);
            console.info('');
        }
    }
    allPassed() {
        return this.results.every(r => r.p95 <= TARGETS.p95LatencyMs &&
            r.errPct <= TARGETS.errorRatePct &&
            r.tput >= TARGETS.throughputQps);
    }
}
/* ------------------------------------------------------------------
 * CLI runner
 * ------------------------------------------------------------------ */
async function main() {
    const bench = new PoolBench();
    const args = process.argv.slice(2);
    const wantQuick = args.includes('--quick');
    const wantTiers = args.includes('--tiers');
    const wantCpx21 = args.includes('--tier') && args.includes('cpx21');
    if (args.includes('--help')) {
        console.info(`Usage: bun benchmark [options]

Options:
  --quick        Quick benchmark (pool=4, concurrency=20, 5s)
  --tier cpx21   Simulate CPX21 tier (pool=4, concurrency=60, 10s)
  --tiers        Run all Hetzner tiers (CPX11/21/31/41)
  --help         Show this help

Targets: p95 < ${TARGETS.p95LatencyMs}ms, error < ${TARGETS.errorRatePct}%, throughput > ${TARGETS.throughputQps} qps
`);
        process.exit(0);
    }
    try {
        if (wantTiers) {
            for (const t of HETZNER_TIERS) {
                await bench.run({
                    poolSize: t.pool,
                    concurrency: t.pool * 15,
                    durationSec: 10,
                    op: 'mixed',
                    tierName: t.name,
                    tierCost: t.monthly
                });
            }
        }
        else if (wantCpx21) {
            const cpx21 = HETZNER_TIERS.find(t => t.name === 'CPX21');
            await bench.run({
                poolSize: cpx21.pool,
                concurrency: cpx21.pool * 15,
                durationSec: 10,
                op: 'mixed',
                tierName: cpx21.name,
                tierCost: cpx21.monthly
            });
        }
        else if (wantQuick) {
            await bench.run({
                poolSize: 4,
                concurrency: 20,
                durationSec: 5,
                op: 'mixed'
            });
        }
        else {
            // Default: Quick test
            await bench.run({
                poolSize: 4,
                concurrency: 20,
                durationSec: 5,
                op: 'mixed'
            });
        }
        bench.print();
        const ok = bench.allPassed();
        process.exit(ok ? 0 : 1);
    }
    catch (error) {
        console.error('❌ Benchmark failed:', error);
        process.exit(1);
    }
}
main().catch(console.error);
