#!/usr/bin/env bun
/**
 * Shared load test utilities for application-level HTTP throughput testing.
 *
 * Unlike benchmark.ts (which tests raw SQLite pool.exec() calls), these utilities
 * measure end-to-end HTTP performance through the full stack: HTTP server, middleware,
 * the ORM/query layer, SSR rendering, etc.
 *
 * Usage:
 *   Import into app-specific load tests:
 *     import { runLoadTest, formatResults } from '@bitclaw/sqlite/load-test-utils'
 *
 *   Or run directly for a quick test:
 *     bun run packages/sqlite/scripts/load-test-utils.ts --url http://localhost:3001
 */
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
    /**
     * Optional: number of times to repeat each scenario (default 1).
     * When > 1, each (endpoint, concurrency) runs N times and results are
     * aggregated — medians for throughput/latency, plus a coefficient of
     * variation so run-to-run dispersion is visible. Defends against the
     * ~±30% single-run variance seen on virtualized hosts (e.g. WSL2).
     */
    repeat?: number;
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
    /**
     * Per-worker cookie pool. When set, each concurrent worker i receives
     * `Cookie: cookiePool[i % cookiePool.length]` instead of the shared
     * `headers.Cookie`. Use for multi-user load tests where each worker
     * should hit a distinct session/DB.
     */
    cookiePool?: string[];
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
    throughput: number;
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
    avg: number;
    statusCodes: Record<number, number>;
    avgBodySize: number;
    via?: 'cdn' | 'direct';
    /**
     * Variance fields — only populated when the scenario was run more than
     * once (LoadTestConfig.repeat > 1). Absent for single-run scenarios, so
     * the single-run output shape is unchanged.
     */
    runs?: number;
    /** Lowest per-run throughput (req/s) across the N runs. */
    throughputMin?: number;
    /** Highest per-run throughput (req/s) across the N runs. */
    throughputMax?: number;
    /** Coefficient of variation of throughput across runs, as a percent. */
    throughputCoV?: number;
    /** Median of the per-run p95 values (NOT p95 of pooled latencies). */
    p95Median?: number;
};
export type LoadTestResults = {
    baseUrl: string;
    startedAt: string;
    completedAt: string;
    scenarios: ScenarioResult[];
};
export declare function percentile(sorted: number[], p: number): number;
export declare function measureResponseTime(url: string, method?: string, body?: string, headers?: Record<string, string>): Promise<RequestResult>;
export declare function runLoadTest(config: LoadTestConfig): Promise<LoadTestResults>;
export declare function formatResults(results: LoadTestResults): string;
//# sourceMappingURL=load-test-utils.d.ts.map