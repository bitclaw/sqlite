// packages/sqlite/src/retry.ts
// Retry with exponential backoff for SQLITE_BUSY errors

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2000
};

const isBusyError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('sqlite_busy') ||
    ('code' in error && (error as { code: string }).code === 'SQLITE_BUSY')
  );
};

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

const calculateDelay = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number
): number => {
  const exponentialDelay = baseDelayMs * 2 ** attempt;
  const jitter = Math.random() * baseDelayMs;
  return Math.min(exponentialDelay + jitter, maxDelayMs);
};

/**
 * Execute a function with retry logic for SQLITE_BUSY errors.
 * Uses exponential backoff with jitter to avoid thundering herd.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_OPTIONS,
    ...options
  };

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      if (!isBusyError(error) || attempt === maxAttempts - 1) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelayMs, maxDelayMs);
      console.warn(
        `[sqlite] SQLITE_BUSY on attempt ${attempt + 1}/${maxAttempts}, retrying in ${Math.round(delay)}ms`
      );
      await sleep(delay);
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}

export type { RetryOptions };
export { isBusyError };
