type DatabaseConfig = {
    path: string;
    options: {
        verbose?: ((message?: unknown, ...additionalArgs: unknown[]) => void) | undefined;
        fileMustExist: boolean;
    };
};
type WorkerMessage = {
    id: string;
    sql: string;
    params?: unknown[];
    type?: string;
};
type WorkerResponse = {
    id: string;
    result?: unknown;
    error?: {
        message: string;
        code?: string;
        errno?: number;
    };
    workerId: string;
    durationMs: number;
    success: boolean;
};
export declare class SQLiteWorker {
    private db;
    private config;
    private workerId;
    constructor(config?: DatabaseConfig);
    private initializeDatabase;
    handleMessage(message: WorkerMessage): Promise<WorkerResponse>;
    private executeQuery;
    shutdown(): void;
    getWorkerId(): string;
}
export {};
//# sourceMappingURL=worker.d.ts.map