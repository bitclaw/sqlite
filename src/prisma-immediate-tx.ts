// packages/sqlite/src/prisma-immediate-tx.ts
// BEGIN IMMEDIATE transaction wrapper for Prisma with libsql adapter
//
// Prisma's $transaction() uses BEGIN DEFERRED by default. When a deferred
// transaction tries to upgrade from read to write lock, SQLite returns
// SQLITE_BUSY *immediately* — bypassing busy_timeout entirely.
//
// This helper wraps writes in BEGIN IMMEDIATE via $executeRawUnsafe,
// which acquires the write lock upfront and respects busy_timeout.

type PrismaClientLike = {
  $executeRawUnsafe: (sql: string) => Promise<number>;
  $queryRawUnsafe: (sql: string) => Promise<unknown>;
};

/**
 * Execute a Prisma callback within a BEGIN IMMEDIATE transaction.
 *
 * The libsql adapter uses a single connection per PrismaClient, so raw SQL
 * (BEGIN/COMMIT/ROLLBACK) participates in the same connection state as
 * Prisma's query builder. This means we can safely mix raw transaction
 * control with Prisma model operations.
 *
 * @example
 * ```typescript
 * const [response] = await immediateTransaction(prisma, async () => [
 *   await prisma.gptResponse.create({ data: { userId, content } }),
 *   await prisma.user.update({ where: { id: userId }, data: { credits: { decrement: 1 } } }),
 * ]);
 * ```
 */
export async function immediateTransaction<T>(
  client: PrismaClientLike,
  fn: () => Promise<T>
): Promise<T> {
  await client.$executeRawUnsafe('BEGIN IMMEDIATE');

  try {
    const result = await fn();
    await client.$executeRawUnsafe('COMMIT');
    return result;
  } catch (error: unknown) {
    try {
      await client.$executeRawUnsafe('ROLLBACK');
    } catch {
      // Rollback may fail if the connection is already aborted
    }
    throw error;
  }
}
