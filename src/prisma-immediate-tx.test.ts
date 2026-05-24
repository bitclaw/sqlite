import { describe, expect, test } from 'bun:test';
import { immediateTransaction } from './prisma-immediate-tx';

// Mock PrismaClient that tracks SQL calls
const createMockClient = () => {
  const calls: string[] = [];
  return {
    calls,
    $executeRawUnsafe: async (sql: string) => {
      calls.push(sql);
      return 0;
    },
    $queryRawUnsafe: async (sql: string) => {
      calls.push(sql);
      return [];
    }
  };
};

describe('immediateTransaction', () => {
  test('wraps callback in BEGIN IMMEDIATE / COMMIT', async () => {
    const client = createMockClient();

    const result = await immediateTransaction(client, async () => {
      return 'success';
    });

    expect(result).toBe('success');
    expect(client.calls).toEqual(['BEGIN IMMEDIATE', 'COMMIT']);
  });

  test('rolls back on error and rethrows', async () => {
    const client = createMockClient();

    await expect(
      immediateTransaction(client, async () => {
        throw new Error('write failed');
      })
    ).rejects.toThrow('write failed');

    expect(client.calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  test('handles rollback failure gracefully', async () => {
    const calls: string[] = [];
    const client = {
      $executeRawUnsafe: async (sql: string) => {
        calls.push(sql);
        if (sql === 'ROLLBACK') {
          throw new Error('rollback failed');
        }
        return 0;
      },
      $queryRawUnsafe: async (sql: string) => {
        calls.push(sql);
        return [];
      }
    };

    // Should throw the original error, not the rollback error
    await expect(
      immediateTransaction(client, async () => {
        throw new Error('original error');
      })
    ).rejects.toThrow('original error');

    expect(calls).toEqual(['BEGIN IMMEDIATE', 'ROLLBACK']);
  });

  test('returns value from callback', async () => {
    const client = createMockClient();

    const result = await immediateTransaction(client, async () => {
      return { id: '123', name: 'test' };
    });

    expect(result).toEqual({ id: '123', name: 'test' });
  });
});
