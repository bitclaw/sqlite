// Retry with exponential backoff for SQLITE_BUSY errors, on top of the
// runtime-neutral withRetry in @bitclaw/mutex.
import { withRetry as retry } from '@bitclaw/mutex';

type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
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

/**
 * Execute a function with retry logic for SQLITE_BUSY errors.
 * Uses exponential backoff with jitter to avoid thundering herd.
 */
export function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  return retry(fn, {
    maxAttempts,
    baseDelayMs: options?.baseDelayMs ?? 100,
    maxDelayMs: options?.maxDelayMs ?? 2000,
    shouldRetry: isBusyError,
    onRetry: (_error, attempt, delay) =>
      console.warn(
        `[sqlite] SQLITE_BUSY on attempt ${attempt + 1}/${maxAttempts}, retrying in ${Math.round(delay)}ms`
      )
  });
}

export type { RetryOptions };
export { isBusyError };
