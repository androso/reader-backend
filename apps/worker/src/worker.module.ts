import { Module } from "@nestjs/common";
import {
    getRedisConnectionOptions,
    parseRagRerankShadowRateLimit,
} from "@reader/jobs";
import {
    closeDatabasePool,
    shutdownLangfuseTracing,
    startLangfuseTracing,
} from "@reader/api/rag-shadow";
import {
    processBookProcessingJob,
    processRagRerankShadowJob,
    type ProcessUploadedBook,
} from "./processor";
import {
    defaultWorkerFactory,
    WORKER_FACTORY,
    WORKER_RESOURCES,
    WORKER_RUNTIME_DEPENDENCIES,
    WorkerRuntimeService,
    type WorkerFactory,
    type WorkerResources,
    type WorkerRuntimeDependencies,
} from "./worker-runtime.service";

export interface WorkerResourceDependencies {
    closeDatabasePool: () => Promise<unknown>;
    shutdownLangfuseTracing: () => Promise<unknown>;
    startLangfuseTracing: (serviceName?: string) => void;
}

export const PROCESS_UPLOADED_BOOK = "PROCESS_UPLOADED_BOOK";

const loadProcessUploadedBook = (): ProcessUploadedBook => {
    const module = require("@reader/api/book-processing") as {
        processUploadedBook: ProcessUploadedBook;
    };
    return module.processUploadedBook;
};

export const createWorkerResources = (
    deps: WorkerResourceDependencies = {
        closeDatabasePool,
        shutdownLangfuseTracing,
        startLangfuseTracing,
    }
): WorkerResources => {
    let closing: Promise<void> | undefined;
    return {
        startTracing: (serviceName: string) => {
            deps.startLangfuseTracing(serviceName);
        },
        close: () =>
            (closing ??= (async () => {
                const errors: unknown[] = [];
                try {
                    await deps.closeDatabasePool();
                } catch (error) {
                    errors.push(error);
                }
                try {
                    await deps.shutdownLangfuseTracing();
                } catch (error) {
                    errors.push(error);
                }
                if (errors.length) {
                    throw new AggregateError(
                        errors,
                        "Worker resource shutdown failed"
                    );
                }
            })()),
    };
};

export const defaultWorkerResources = createWorkerResources();

@Module({
    providers: [
        {
            provide: PROCESS_UPLOADED_BOOK,
            inject: [],
            useFactory: loadProcessUploadedBook,
        },
        {
            provide: WORKER_FACTORY,
            inject: [],
            useFactory: (): WorkerFactory => defaultWorkerFactory,
        },
        {
            provide: WORKER_RUNTIME_DEPENDENCIES,
            inject: [PROCESS_UPLOADED_BOOK],
            useFactory: (
                processUploadedBook: ProcessUploadedBook
            ): WorkerRuntimeDependencies => ({
                processBookProcessingJob: (job) =>
                    processBookProcessingJob(job, processUploadedBook),
                processRagRerankShadowJob,
                getRedisConnectionOptions,
                getRagRerankShadowRateLimit: () =>
                    parseRagRerankShadowRateLimit(
                        process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE
                    ),
                logger: console,
            }),
        },
        {
            provide: WORKER_RESOURCES,
            inject: [],
            useFactory: (): WorkerResources => defaultWorkerResources,
        },
        WorkerRuntimeService,
    ],
})
export class WorkerModule {}
