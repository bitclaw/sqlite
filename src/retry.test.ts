import { describe, expect, test } from 'bun:test';
import { isBusyError, withRetry } from './retry';

describe('isBusyError', () => {
  test('detects "database is locked" message', () => {
    expect(isBusyError(new Error('database is locked'))).toBe(true);
  });

  test('detects "SQLITE_BUSY" message', () => {
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(
      true
    );
  });

  test('detects SQLITE_BUSY error code', () => {
    const error = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' });
    expect(isBusyError(error)).toBe(true);
  });

  test('returns false for non-busy errors', () => {
    expect(isBusyError(new Error('syntax error'))).toBe(false);
  });

  test('returns false for non-Error values', () => {
    expect(isBusyError('database is locked')).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });
});

describe('withRetry', () => {
  test('returns result on first success', async () => {
    const result = await withRetry(async () => 42);
    expect(result).toBe(42);
  });

  test('retries on SQLITE_BUSY and succeeds', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('database is locked');
        }
        return 'success';
      },
      { maxAttempts: 3, baseDelayMs: 10 }
    );

    expect(result).toBe('success');
    expect(attempts).toBe(3);
  });

  test('throws after exhausting retries', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('database is locked');
        },
        { maxAttempts: 3, baseDelayMs: 10 }
      )
    ).rejects.toThrow('database is locked');

    expect(attempts).toBe(3);
  });

  test('does not retry non-BUSY errors', async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('syntax error');
        },
        { maxAttempts: 3, baseDelayMs: 10 }
      )
    ).rejects.toThrow('syntax error');

    expect(attempts).toBe(1);
  });

  test('respects maxDelayMs cap', async () => {
    const start = Date.now();
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error('database is locked');
        },
        { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 }
      )
    ).rejects.toThrow('database is locked');

    // With maxDelayMs=50, total delay should be well under 200ms
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(attempts).toBe(3);
  });
});
