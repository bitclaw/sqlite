import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

// =============================================================================
// MOCKS
// =============================================================================

type MessageHandler = (msg: unknown) => void;

// Track all worker instances and their handlers
const workerInstances: Array<{
  onMessage: MessageHandler | null;
  postMessage: ReturnType<typeof mock>;
  terminate: ReturnType<typeof mock>;
}> = [];

const MockWorker = function MockWorker() {
  const instance = {
    onMessage: null as MessageHandler | null,
    postMessage: mock(),
    terminate: mock(() => Promise.resolve()),
    on: mock(function on(event: string, handler: unknown) {
      if (event === 'message') instance.onMessage = handler as MessageHandler;
      return instance;
    })
  };
  workerInstances.push(instance);
  return instance;
};

mock.module('node:worker_threads', () => ({
  Worker: MockWorker,
  isMainThread: true,
  parentPort: null,
  workerData: null,
  threadId: 0,
  MessageChannel: class {},
  MessagePort: class {},
  BroadcastChannel: class {}
}));

mock.module('node:module', () => ({
  createRequire: () => ({
    resolve: () => '/fake/worker.js'
  }),
  Module: class {},
  builtinModules: []
}));

// =============================================================================
// RE-IMPORT HELPER
// Since the pool module has module-level singleton state, we need to clear
// the module cache between tests that need isolated state.
// =============================================================================

// We'll use a timestamp-based import to bust the module cache.
// For bun, we can use `Loader.registry.delete` — but that's internal.
// Instead, we'll design tests to work with the singleton constraint.
// Tests that create pools will shut them down; each test manages its own lifecycle.

let mod: typeof import('./pool');

beforeEach(async () => {
  workerInstances.length = 0;
  mod = await import('./pool');
});

afterEach(async () => {
  // Force shutdown without WAL checkpoint
  // We just terminate workers directly since the WAL checkpoint would hang
  try {
    // Access the pool directly and shut it down
    const status = mod.getPoolStatus();
    if (!status.isShuttingDown) {
      // The pool's shutdown calls exec('PRAGMA wal_checkpoint') which hangs.
      // Instead, we need to respond to any pending messages to unblock.
      // But the simplest fix: just ensure pool is shutdown-able by auto-responding.
      for (const worker of workerInstances) {
        if (worker.onMessage) {
          // Auto-respond to any pending WAL checkpoint
          worker.postMessage.mockImplementation(
            (msg: { id: string; sql: string }) => {
              if (
                msg.sql === 'PRAGMA wal_checkpoint(TRUNCATE)' ||
                msg.sql === '__SHUTDOWN__'
              ) {
                setTimeout(() => {
                  if (worker.onMessage) {
                    worker.onMessage({
                      id: msg.id,
                      result: undefined,
                      success: true
                    });
                  }
                }, 0);
              }
            }
          );
        }
      }
    }
    await mod.shutdownPool(500);
  } catch {
    // ignore
  }
});

// =============================================================================
// TESTS
// =============================================================================

describe('Pool creation', () => {
  test('given poolSize=2, when creating pool, then creates 2 workers', () => {
    mod.createPool({ poolSize: 2 });

    expect(workerInstances).toHaveLength(2);
  });

  test('given pool already exists, when creating again, then throws', async () => {
    mod.createPool({ poolSize: 1 });

    expect(() => mod.createPool({ poolSize: 1 })).toThrow(
      'Pool already exists'
    );
  });
});

describe('Singleton pattern', () => {
  test('given no pool exists, when getPool called, then creates pool', () => {
    const pool = mod.getPool();

    expect(pool).toBeDefined();
    expect(workerInstances.length).toBeGreaterThan(0);
  });

  test('given pool exists, when getPool called again, then returns same instance', () => {
    const pool1 = mod.getPool();
    const pool2 = mod.getPool();

    expect(pool1).toBe(pool2);
  });
});

describe('Query execution', () => {
  test('given pool created, when exec called, then posts message to worker', async () => {
    mod.createPool({ poolSize: 1 });
    const worker = workerInstances[0]!;

    const promise = mod.exec('SELECT 1');

    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const msg = worker.postMessage.mock.calls[0]![0] as {
      id: string;
      sql: string;
    };
    expect(msg.sql).toBe('SELECT 1');

    // Respond
    worker.onMessage!({
      id: msg.id,
      result: [{ '1': 1 }],
      success: true
    });

    const result = await promise;
    expect(result).toEqual([{ '1': 1 }]);
  });

  test('given worker returns error, when exec called, then rejects', async () => {
    mod.createPool({ poolSize: 1 });
    const worker = workerInstances[0]!;

    const promise = mod.exec('BAD SQL');
    const msg = worker.postMessage.mock.calls[0]![0] as { id: string };

    worker.onMessage!({
      id: msg.id,
      error: { message: 'near "BAD": syntax error' },
      success: false
    });

    expect(promise).rejects.toThrow('syntax error');
  });

  test('given query exceeds timeout, when exec called, then rejects with timeout', async () => {
    mod.createPool({ poolSize: 1, timeout: 50 });

    // Don't respond — let it timeout
    expect(mod.exec('SELECT sleep()')).rejects.toThrow('timed out');
  });
});

describe('Round-robin distribution', () => {
  test('given 2 workers, when 3 queries sent, then distributes across workers', async () => {
    mod.createPool({ poolSize: 2 });
    const worker0 = workerInstances[0]!;
    const worker1 = workerInstances[1]!;

    mod.exec('Q1');
    mod.exec('Q2');
    mod.exec('Q3');

    // Q1→worker0, Q2→worker1, Q3→worker0
    expect(worker0.postMessage).toHaveBeenCalledTimes(2);
    expect(worker1.postMessage).toHaveBeenCalledTimes(1);

    // Clean up pending queries by responding
    for (const worker of workerInstances) {
      for (const call of worker.postMessage.mock.calls) {
        const msg = call![0] as { id: string };
        worker.onMessage!({ id: msg.id, result: 'ok', success: true });
      }
    }
  });
});

describe('Metrics tracking', () => {
  test('given query succeeds, when getMetrics called, then tracks totals', async () => {
    mod.createPool({ poolSize: 1 });
    const worker = workerInstances[0]!;

    const promise = mod.exec('SELECT 1');
    const msg = worker.postMessage.mock.calls[0]![0] as { id: string };

    worker.onMessage!({
      id: msg.id,
      result: 1,
      success: true,
      workerId: 'worker-0'
    });
    await promise;

    const metrics = mod.getPoolMetrics();
    expect(metrics.totalQueries).toBe(1);
    expect(metrics.errors).toBe(0);
    expect(metrics.workerStats['worker-0']).toBeDefined();
    expect(metrics.workerStats['worker-0']!.queries).toBe(1);
  });

  test('given query fails, when getMetrics called, then increments errors', async () => {
    mod.createPool({ poolSize: 1 });
    const worker = workerInstances[0]!;

    const promise = mod.exec('BAD');
    const msg = worker.postMessage.mock.calls[0]![0] as { id: string };

    worker.onMessage!({
      id: msg.id,
      error: { message: 'error' },
      success: false,
      workerId: 'worker-0'
    });

    try {
      await promise;
    } catch {
      /* expected */
    }

    const metrics = mod.getPoolMetrics();
    expect(metrics.errors).toBe(1);
  });
});

describe('Pool status', () => {
  test('given pool created, when getStatus called, then returns health info', () => {
    mod.createPool({ poolSize: 2 });

    const status = mod.getPoolStatus();
    expect(status.workers).toBe(2);
    expect(status.activeQueries).toBe(0);
    expect(status.isShuttingDown).toBe(false);
  });
});

describe('Graceful shutdown', () => {
  test('given pool active, when shutdown called, then terminates workers', async () => {
    mod.createPool({ poolSize: 2 });

    // Set up auto-respond for shutdown messages
    for (const worker of workerInstances) {
      worker.postMessage.mockImplementation(
        (msg: { id: string; sql: string }) => {
          setTimeout(() => {
            if (worker.onMessage) {
              worker.onMessage({
                id: msg.id,
                result: undefined,
                success: true
              });
            }
          }, 0);
        }
      );
    }

    await mod.shutdownPool(500);

    // Each worker should have been terminated
    for (const worker of workerInstances) {
      expect(worker.terminate).toHaveBeenCalled();
    }
  });

  test('given pool shut down, when exec called on instance, then throws', async () => {
    const pool = mod.createPool({ poolSize: 1 });

    // Auto-respond
    const worker = workerInstances[0]!;
    worker.postMessage.mockImplementation(
      (msg: { id: string; sql: string }) => {
        setTimeout(() => {
          if (worker.onMessage) {
            worker.onMessage({ id: msg.id, result: undefined, success: true });
          }
        }, 0);
      }
    );

    await mod.shutdownPool(500);

    // getPool creates a new pool, so we test directly on the old instance
    expect(pool.exec('SELECT 1')).rejects.toThrow('shutting down');
  });
});

describe('Transaction support', () => {
  test('given pool active, when withTransaction called, then wraps in BEGIN/COMMIT', async () => {
    mod.createPool({ poolSize: 1 });
    const worker = workerInstances[0]!;

    // Auto-respond to all messages
    worker.postMessage.mockImplementation(
      (msg: { id: string; sql: string }) => {
        setTimeout(() => {
          if (worker.onMessage) {
            worker.onMessage({ id: msg.id, result: undefined, success: true });
          }
        }, 0);
      }
    );

    const result = await mod.withTransaction(async execute => {
      await execute('INSERT INTO test VALUES (1)');
      return 'done';
    });

    expect(result).toBe('done');

    // Verify SQL order: BEGIN IMMEDIATE, INSERT, COMMIT
    const calls = worker.postMessage.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect((calls[0]![0] as { sql: string }).sql).toBe('BEGIN IMMEDIATE');
    expect((calls[1]![0] as { sql: string }).sql).toBe(
      'INSERT INTO test VALUES (1)'
    );
    expect((calls[2]![0] as { sql: string }).sql).toBe('COMMIT');
  });
});
