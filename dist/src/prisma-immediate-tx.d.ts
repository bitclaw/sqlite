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
export declare function immediateTransaction<T>(client: PrismaClientLike, fn: () => Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=prisma-immediate-tx.d.ts.map