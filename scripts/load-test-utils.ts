#!/usr/bin/env bun
/**
 * Shared load test utilities for application-level HTTP throughput testing.
 *
 * Unlike benchmark.ts (which tests raw SQLite pool.exec() calls), these utilities
 * measure end-to-end HTTP performance through the full stack: HTTP server, middleware,
 * ORM (Prisma), SSR rendering, etc.
 *
 * Usage:
 *   Import into app-specific load tests:
 *     import { runLoadTest, formatResults } from '@bitclaw/sqlite/load-test-utils'
 *
 *   Or run directly for a quick test:
 *     bun run packages/sqlite/scripts/load-test-utils.ts --url http://localhost:3001
 */

/* ------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------ */
export type LoadTestConfig = {
  /** Base URL of the application (e.g., http://localhost:3001) */
  baseUrl: string;
  /** Endpoints to test, relative to baseUrl */
  endpoints: EndpointConfig[];
  /** Concurrency levels to test */
  concurrencyLevels: number[];
  /** Duration per scenario in seconds */
  durationSec: number;
  /** Optional: warm-up requests before timing */
  warmupRequests?: number;
};

export type EndpointConfig = {
  /** Path relative to baseUrl (e.g., '/healthcheck') */
  path: string;
  /** HTTP method (default: GET) */
  method?: string;
  /** Request body for POST/PUT */
  body?: string;
  /** Additional headers */
  headers?: Record<string, string>;
  /** Human-readable label */
  label?: string;
};

export type RequestResult = {
  statusCode: number;
  latencyMs: number;
  success: boolean;
  bodySize: number;
};

export type ScenarioResult = {
  endpoint: string;
  label: string;
  method: string;
  concurrency: number;
  durationSec: number;

  totalRequests: number;
  successCount: number;
  failCount: number;
  successRate: number;

  throughput: number; // req/s

  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  avg: number;

  statusCodes: Record<number, number>;
  avgBodySize: number;

  via?: 'cdn' | 'direct';
};

export type LoadTestResults = {
  baseUrl: string;
  startedAt: string;
  completedAt: string;
  scenarios: ScenarioResult[];
};

/* ------------------------------------------------------------------
 * Percentile calculation (reused from benchmark.ts)
 * ------------------------------------------------------------------ */
export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loVal = sorted[lo] ?? 0;
  const hiVal = sorted[hi] ?? 0;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

/* ------------------------------------------------------------------
 * Single request measurement
 * ------------------------------------------------------------------ */
export async function measureResponseTime(
  url: string,
  method = 'GET',
  body?: string,
  headers?: Record<string, string>
): Promise<RequestResult> {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      method,
      body: method !== 'GET' ? body : undefined,
      headers: {
        Accept: 'text/html,application/json',
        'User-Agent': 'sqlite-saas-load-test/1.0',
        ...headers
      }
    });
    const responseBody = await response.text();
    const latencyMs = performance.now() - start;

    return {
      statusCode: response.status,
      latencyMs,
      success: response.status >= 200 && response.status < 400,
      bodySize: responseBody.length
    };
  } catch {
    return {
      statusCode: 0,
      latencyMs: performance.now() - start,
      success: false,
      bodySize: 0
    };
  }
}

/* ------------------------------------------------------------------
 * Worker loop for sustained load
 * ------------------------------------------------------------------ */
async function workerLoop(
  url: string,
  method: string,
  body: string | undefined,
  headers: Record<string, string> | undefined,
  endTs: number,
  results: RequestResult[]
): Promise<void> {
  while (performance.now() < endTs) {
    const result = await measureResponseTime(url, method, body, headers);
    results.push(result);
  }
}

/* ------------------------------------------------------------------
 * Run a single scenario (one endpoint at one concurrency level)
 * ------------------------------------------------------------------ */
async function runScenario(
  baseUrl: string,
  endpoint: EndpointConfig,
  concurrency: number,
  durationSec: number,
  warmupRequests: number
): Promise<ScenarioResult> {
  const url = `${baseUrl}${endpoint.path}`;
  const method = endpoint.method ?? 'GET';
  const label = endpoint.label ?? endpoint.path;

  // Warm-up phase
  if (warmupRequests > 0) {
    const warmups = Array.from(
      { length: Math.min(warmupRequests, concurrency) },
      () => measureResponseTime(url, method, endpoint.body, endpoint.headers)
    );
    await Promise.allSettled(warmups);
  }

  // Measurement phase
  const results: RequestResult[] = [];
  const endTs = performance.now() + durationSec * 1000;

  const workers = Array.from({ length: concurrency }, () =>
    workerLoop(url, method, endpoint.body, endpoint.headers, endTs, results)
  );
  await Promise.allSettled(workers);

  // Calculate metrics
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  const successCount = results.filter(r => r.success).length;
  const failCount = results.length - successCount;
  const totalBodySize = results.reduce((sum, r) => sum + r.bodySize, 0);

  const statusCodes: Record<number, number> = {};
  for (const r of results) {
    statusCodes[r.statusCode] = (statusCodes[r.statusCode] ?? 0) + 1;
  }

  return {
    endpoint: endpoint.path,
    label,
    method,
    concurrency,
    durationSec,

    totalRequests: results.length,
    successCount,
    failCount,
    successRate: results.length > 0 ? (successCount / results.length) * 100 : 0,

    throughput: results.length / durationSec,

    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    min: latencies[0] ?? 0,
    max: latencies.at(-1) ?? 0,
    avg:
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0,

    statusCodes,
    avgBodySize: results.length > 0 ? totalBodySize / results.length : 0
  };
}

/* ------------------------------------------------------------------
 * Main load test runner
 * ------------------------------------------------------------------ */
export async function runLoadTest(
  config: LoadTestConfig
): Promise<LoadTestResults> {
  const startedAt = new Date().toISOString();
  const scenarios: ScenarioResult[] = [];
  const warmup = config.warmupRequests ?? 5;

  for (const endpoint of config.endpoints) {
    for (const concurrency of config.concurrencyLevels) {
      const _label = endpoint.label ?? endpoint.path;

      const result = await runScenario(
        config.baseUrl,
        endpoint,
        concurrency,
        config.durationSec,
        warmup
      );
      scenarios.push(result);
    }
  }

  return {
    baseUrl: config.baseUrl,
    startedAt,
    completedAt: new Date().toISOString(),
    scenarios
  };
}

/* ------------------------------------------------------------------
 * Format results as a table
 * ------------------------------------------------------------------ */
export function formatResults(results: LoadTestResults): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(100));
  lines.push('  APPLICATION-LEVEL LOAD TEST RESULTS');
  lines.push(`  Target: ${results.baseUrl}`);
  lines.push(`  Started: ${results.startedAt}`);
  lines.push(`  Completed: ${results.completedAt}`);
  lines.push('='.repeat(100));
  lines.push('');

  // Summary table header
  const header = [
    'Endpoint'.padEnd(25),
    'Conc'.padStart(5),
    'Req/s'.padStart(8),
    'Total'.padStart(7),
    'P50ms'.padStart(8),
    'P95ms'.padStart(8),
    'P99ms'.padStart(8),
    'Success'.padStart(8),
    'AvgBody'.padStart(8)
  ].join(' | ');

  lines.push(header);
  lines.push('-'.repeat(header.length));

  for (const s of results.scenarios) {
    const row = [
      s.label.padEnd(25).slice(0, 25),
      String(s.concurrency).padStart(5),
      s.throughput.toFixed(0).padStart(8),
      String(s.totalRequests).padStart(7),
      s.p50.toFixed(1).padStart(8),
      s.p95.toFixed(1).padStart(8),
      s.p99.toFixed(1).padStart(8),
      `${s.successRate.toFixed(1)}%`.padStart(8),
      formatBytes(s.avgBodySize).padStart(8)
    ].join(' | ');
    lines.push(row);
  }

  lines.push('');

  // Pool-level comparison note
  lines.push('-'.repeat(100));
  lines.push(
    '  NOTE: Pool-level benchmarks (raw pool.exec) show 6,102-13,781 req/s.'
  );
  lines.push(
    '  Application-level throughput is lower due to HTTP overhead, middleware,'
  );
  lines.push('  Prisma ORM, SSR rendering, and serialization.');
  lines.push('-'.repeat(100));
  lines.push('');

  // Status code breakdown
  lines.push('  Status Code Breakdown:');
  for (const s of results.scenarios) {
    const codes = Object.entries(s.statusCodes)
      .map(([code, count]) => `${code}:${count}`)
      .join(', ');
    lines.push(`    ${s.label} @${s.concurrency}: ${codes}`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/* ------------------------------------------------------------------
 * CLI: run directly for a quick smoke test
 * ------------------------------------------------------------------ */
async function main() {
  const args = process.argv.slice(2);
  const urlIdx = args.indexOf('--url');
  const baseUrl =
    (urlIdx !== -1 ? args[urlIdx + 1] : undefined) ?? 'http://localhost:3001';

  if (args.includes('--help')) {
    process.exit(0);
  }

  // Quick smoke test against the provided URL
  const _results = await runLoadTest({
    baseUrl,
    endpoints: [{ path: '/', label: 'Homepage' }],
    concurrencyLevels: [1, 10],
    durationSec: 5,
    warmupRequests: 3
  });
}

// Run if executed directly
if (import.meta.path === Bun.main) {
  main().catch(err => {
    console.error('Load test failed:', err);
    process.exit(1);
  });
}
