import { describe, expect, test } from 'bun:test';
import {
  formatResults,
  type LoadTestResults,
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
