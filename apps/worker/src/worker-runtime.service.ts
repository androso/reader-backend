/// <reference lib="es2021" />
import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { Worker, type Processor, type WorkerOptions } from "bullmq";
import {
    BOOK_PROCESSING_QUEUE_NAME,
    RAG_RERANK_SHADOW_CONCURRENCY,
    RAG_RERANK_SHADOW_MAX_STARTED_ATTEMPTS,
    RAG_RERANK_SHADOW_QUEUE_NAME,
    type BookProcessingJobData,
    type RagRerankShadowJobData,
    type getRedisConnectionOptions,
} from "@reader/jobs";
import {
    getRagShadowFailureMetadata,
    type processBookProcessingJob,
    type processRagRerankShadowJob,
} from "./processor";

export const WORKER_FACTORY = "WORKER_FACTORY";
export const WORKER_RUNTIME_DEPENDENCIES = "WORKER_RUNTIME_DEPENDENCIES";
export const WORKER_RESOURCES = "WORKER_RESOURCES";

export type WorkerFactory = <T>(
    queueName: string,
    processor: Processor<T>,
    options: WorkerOptions
) => Worker<T>;

export const defaultWorkerFactory: WorkerFactory = (
    queueName,
    processor,
    options
) => new Worker(queueName, processor, options);

export interface WorkerRuntimeLogger {
    log(message?: unknown, ...optionalParams: unknown[]): void;
    error(message?: unknown, ...optionalParams: unknown[]): void;
}

export interface WorkerRuntimeDependencies {
    processBookProcessingJob: typeof processBookProcessingJob;
    processRagRerankShadowJob: typeof processRagRerankShadowJob;
    getRedisConnectionOptions: typeof getRedisConnectionOptions;
    getRagRerankShadowRateLimit: () => number;
    logger: WorkerRuntimeLogger;
}

export interface WorkerResources {
    startTracing(serviceName: string): void;
    close(): Promise<void>;
}

@Injectable()
export class WorkerRuntimeService
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly workers: Worker[] = [];
    private closing: Promise<void> | undefined;
    private started = false;

    constructor(
        @Inject(WORKER_FACTORY)
        private readonly createWorker: WorkerFactory,
        @Inject(WORKER_RUNTIME_DEPENDENCIES)
        private readonly deps: WorkerRuntimeDependencies,
        @Inject(WORKER_RESOURCES)
        private readonly resources: WorkerResources
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        if (this.started || this.closing) return;
        this.started = true;

        try {
            const bookWorkerOptions: WorkerOptions = {
                connection: this.deps.getRedisConnectionOptions(),
            };
            const shadowWorkerOptions: WorkerOptions = {
                connection: this.deps.getRedisConnectionOptions(),
                concurrency: RAG_RERANK_SHADOW_CONCURRENCY,
                maxStartedAttempts: RAG_RERANK_SHADOW_MAX_STARTED_ATTEMPTS,
                limiter: {
                    max: this.deps.getRagRerankShadowRateLimit(),
                    duration: 60_000,
                },
            };

            const worker = this.createWorker<BookProcessingJobData>(
                BOOK_PROCESSING_QUEUE_NAME,
                (job) => this.deps.processBookProcessingJob(job),
                bookWorkerOptions
            );
            this.workers.push(worker);

            const shadowWorker = this.createWorker<RagRerankShadowJobData>(
                RAG_RERANK_SHADOW_QUEUE_NAME,
                (job) => this.deps.processRagRerankShadowJob(job),
                shadowWorkerOptions
            );
            this.workers.push(shadowWorker);

            worker.on("completed", (job) => {
                this.deps.logger.log(`Book processing job ${job.id} completed`);
            });

            worker.on("failed", (job, error) => {
                this.deps.logger.error(
                    `Book processing job ${job?.id ?? "unknown"} failed`,
                    error
                );
            });

            shadowWorker.on("completed", (job) => {
                this.deps.logger.log(`RAG shadow job ${job.id} completed`);
            });

            shadowWorker.on("failed", (job, error) => {
                this.deps.logger.error(
                    "RAG shadow job failed",
                    getRagShadowFailureMetadata(job, error)
                );
            });

            this.deps.logger.log(
                `Book processing worker listening on ${BOOK_PROCESSING_QUEUE_NAME}`
            );
            this.deps.logger.log(
                `RAG shadow worker listening on ${RAG_RERANK_SHADOW_QUEUE_NAME}`
            );
        } catch (error) {
            try {
                await this.close();
            } catch (closeError) {
                throw new AggregateError(
                    [error, closeError],
                    "Worker startup and shutdown failed"
                );
            }
            throw error;
        }
    }

    close(): Promise<void> {
        return (this.closing ??= (async () => {
            const results = await Promise.allSettled(
                this.workers.map((worker) =>
                    Promise.resolve().then(() => worker.close())
                )
            );
            const errors = results.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : []
            );
            try {
                await this.resources.close();
            } catch (error) {
                errors.push(error);
            }
            if (errors.length)
                throw new AggregateError(errors, "Worker shutdown failed");
        })());
    }

    onModuleDestroy(): Promise<void> {
        return this.close();
    }
}
