type RetryOptions = {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
};
declare const isBusyError: (error: unknown) => boolean;
/**
 * Execute a function with retry logic for SQLITE_BUSY errors.
 * Uses exponential backoff with jitter to avoid thundering herd.
 */
export declare function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T>;
export type { RetryOptions };
export { isBusyError };
//# sourceMappingURL=retry.d.ts.map