import { describe, expect, test } from 'bun:test';
import {
  formatResults,
  type LoadTestResults,
  runLoadTest,
  type ScenarioResult
} from './load-test-utils';

function makeScenario(overrides: Partial<ScenarioResult> = {}): ScenarioResult {
  return {
    endpoint: '/dashboard',
    label: 'Dashboard',
    method: 'GET',
    concurrency: 100,
    durationSec: 10,
    totalRequests: 12_000,
    successCount: 12_000,
    failCount: 0,
    successRate: 100,
    throughput: 1200,
    p50: 60,
    p95: 150,
    p99: 240,
    min: 5,
    max: 400,
    avg: 70,
    statusCodes: { 200: 12_000 },
    avgBodySize: 6400,
    ...overrides
  };
}

function makeResults(scenarios: ScenarioResult[]): LoadTestResults {
  return {
    baseUrl: 'http://localhost:3000',
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    scenarios
  };
}

describe('formatResults — stack-overhead note', () => {
  test('given any results, when formatted, then note does not mention Prisma', () => {
    const report = formatResults(makeResults([makeScenario()]));
    expect(report).not.toContain('Prisma');
  });

  test('given any results, when formatted, then note omits stale hardcoded pool numbers', () => {
    const report = formatResults(makeResults([makeScenario()]));
    expect(report).not.toContain('6,102-13,781');
  });

  test('given any results, when formatted, then note credits the ORM/query layer generically', () => {
    const report = formatResults(makeResults([makeScenario()]));
    expect(report).toContain('ORM/query');
  });
});

describe('runLoadTest — pathPool', () => {
  test('given a pathPool, when concurrency exceeds the pool size, then each worker requests its own path, round-robin', async () => {
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requestedPaths.push(new URL(req.url).pathname);
        return new Response('ok');
      }
    });

    try {
      const results = await runLoadTest({
        baseUrl: `http://localhost:${server.port}`,
        endpoints: [
          {
            path: '/workspace/{workspaceId}/dashboard',
            label: 'Dashboard',
            pathPool: [
              '/workspace/wsp_a/dashboard',
              '/workspace/wsp_b/dashboard',
              '/workspace/wsp_c/dashboard'
            ]
          }
        ],
        concurrencyLevels: [5],
        durationSec: 1,
        warmupRequests: 0
      });

      expect(results.scenarios[0]?.successRate).toBe(100);
      const uniquePaths = new Set(requestedPaths);
      expect(uniquePaths).toEqual(
        new Set([
          '/workspace/wsp_a/dashboard',
          '/workspace/wsp_b/dashboard',
          '/workspace/wsp_c/dashboard'
        ])
      );
      // Never the literal template path - pathPool must fully override it.
      expect(requestedPaths).not.toContain('/workspace/{workspaceId}/dashboard');
    } finally {
      server.stop();
    }
  });

  test('given no pathPool, when run, then the literal path is used for every request (unchanged behavior)', async () => {
    const requestedPaths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        requestedPaths.push(new URL(req.url).pathname);
        return new Response('ok');
      }
    });

    try {
      await runLoadTest({
        baseUrl: `http://localhost:${server.port}`,
        endpoints: [{ path: '/dashboard', label: 'Dashboard' }],
        concurrencyLevels: [3],
        durationSec: 1,
        warmupRequests: 0
      });

      expect(new Set(requestedPaths)).toEqual(new Set(['/dashboard']));
    } finally {
      server.stop();
    }
  });
});

describe('formatResults — variance (CoV) column', () => {
  test('given single-run scenarios, when formatted, then no CoV column is shown', () => {
    const report = formatResults(makeResults([makeScenario()]));
    expect(report).not.toContain('CoV%');
    expect(report).not.toContain('Runs');
  });

  test('given a repeated scenario, when formatted, then a CoV column appears', () => {
    const report = formatResults(
      makeResults([
        makeScenario({ runs: 3, throughputCoV: 18, p95Median: 150 })
      ])
    );
    expect(report).toContain('CoV%');
    expect(report).toContain('±18%');
    expect(report).toContain('coefficient of variation');
  });
});
