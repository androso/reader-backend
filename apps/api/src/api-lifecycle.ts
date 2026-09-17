import type { Server } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { defaultRateLimitClientOwner } from "./common/rate-limit.module";
import { closeDatabasePool } from "./db";
import { shutdownLangfuseTracing } from "./observability/langfuse";
import { closeBookProcessingQueue } from "./services/BookProcessingQueue";
import { closeRagRerankShadowQueue } from "./services/RagShadowQueue";

const SHUTDOWN_TIMEOUT_MS = 10000;

export interface ApiResourceDeps {
    closeBookQueue(): Promise<void>;
    closeShadowQueue(): Promise<void>;
    closeRateLimit(): Promise<void>;
    closeDatabase(): Promise<void>;
    shutdownTracing(): Promise<void>;
}

export interface ApiResources {
    close(): Promise<void>;
}

export const createApiResources = (deps: ApiResourceDeps): ApiResources => {
    let closing: Promise<void> | undefined;
    return {
        close() {
            return (closing ??= (async () => {
                const errors: unknown[] = [];
                const producers = await Promise.allSettled(
                    [
                        deps.closeBookQueue,
                        deps.closeShadowQueue,
                        deps.closeRateLimit,
                    ].map((close) => Promise.resolve().then(() => close()))
                );
                for (const producer of producers) {
                    if (producer.status === "rejected") {
                        errors.push(producer.reason);
                    }
                }
                try {
                    await deps.closeDatabase();
                } catch (error) {
                    errors.push(error);
                }
                try {
                    await deps.shutdownTracing();
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length) {
                    throw new AggregateError(
                        errors,
                        "API resource shutdown failed"
                    );
                }
            })());
        },
    };
};

export const defaultApiResources: ApiResources = createApiResources({
    closeBookQueue: closeBookProcessingQueue,
    closeShadowQueue: closeRagRerankShadowQueue,
    closeRateLimit: () => defaultRateLimitClientOwner.close(),
    closeDatabase: closeDatabasePool,
    shutdownTracing: shutdownLangfuseTracing,
});

export const closeHttpServer = (server: Server) =>
    new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
            if (
                error &&
                (error as NodeJS.ErrnoException).code !==
                    "ERR_SERVER_NOT_RUNNING"
            ) {
                reject(error);
                return;
            }
            resolve();
        });
    });

export const attachApiLifecycle = (
    app: NestExpressApplication,
    resources: ApiResources
): void => {
    const originalClose = app.close.bind(app) as (
        signal?: string
    ) => Promise<void>;
    let closing: Promise<void> | undefined;
    app.close = (signal?: string) =>
        (closing ??= (async () => {
            const errors: unknown[] = [];
            try {
                await originalClose(signal);
            } catch (error) {
                errors.push(error);
                try {
                    await closeHttpServer(app.getHttpServer());
                } catch (fallbackError) {
                    errors.push(fallbackError);
                }
            }
            try {
                await resources.close();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length) {
                throw new AggregateError(errors, "API shutdown failed");
            }
        })());
};

export interface ApiProcessDeps {
    createApp(): Promise<NestExpressApplication>;
    resources?: ApiResources;
    port?: string | number;
    setTimer?(ms: number, onTimeout: () => void): unknown;
    clearTimer?(timer: unknown): void;
    exit?(code: number): void;
    logError?(message: string, errors: unknown[]): void;
}

export const runApiProcess = (deps: ApiProcessDeps) => {
    const resources = deps.resources ?? defaultApiResources;
    const port = deps.port ?? (process.env.PORT || 3000);
    const setTimer =
        deps.setTimer ??
        ((ms: number, onTimeout: () => void) =>
            setTimeout(onTimeout, ms).unref());
    const clearTimer =
        deps.clearTimer ??
        ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const logError =
        deps.logError ??
        ((message: string, errors: unknown[]) =>
            console.error(message, new AggregateError(errors, message)));

    let app: NestExpressApplication | undefined;
    let closing: Promise<void> | undefined;
    let exitCalled = false;
    const exitOnce = (code: number) => {
        if (exitCalled) return;
        exitCalled = true;
        exit(code);
    };

    const shutdown = (): Promise<void> =>
        (closing ??= (async () => {
            const errors: unknown[] = [];
            const timer = setTimer(SHUTDOWN_TIMEOUT_MS, () => {
                console.error("Graceful shutdown timed out");
                exitOnce(1);
            });
            try {
                try {
                    await ready;
                } catch (error) {
                    errors.push(error);
                }
                try {
                    if (app) {
                        await app.close();
                    } else {
                        await resources.close();
                    }
                } catch (error) {
                    errors.push(error);
                }
            } finally {
                clearTimer(timer);
                process.off("SIGINT", handleSignal);
                process.off("SIGTERM", handleSignal);
            }
            if (errors.length) {
                logError("API startup or shutdown failed", errors);
            }
            exitOnce(errors.length ? 1 : 0);
        })());

    const handleSignal = (signal: NodeJS.Signals) => {
        console.log(`Received ${signal}; closing API server`);
        void shutdown();
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);

    const ready = Promise.resolve().then(async () => {
        app = await deps.createApp();
        await app.listen(port);
        console.log(`Server running on port ${port}`);
    });
    void ready.catch(() => shutdown());

    return { ready, shutdown };
};
