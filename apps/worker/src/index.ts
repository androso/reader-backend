import { Worker } from "bullmq";
import {
    BOOK_PROCESSING_QUEUE_NAME,
    RAG_RERANK_SHADOW_CONCURRENCY,
    RAG_RERANK_SHADOW_QUEUE_NAME,
    getRedisConnectionOptions,
    parseRagRerankShadowRateLimit,
    type BookProcessingJobData,
    type RagRerankShadowJobData,
} from "@reader/jobs";
import {
    getRagShadowFailureMetadata,
    processBookProcessingJob,
    processRagRerankShadowJob,
} from "./processor";
import {
    closeDatabasePool,
    shutdownLangfuseTracing,
    startLangfuseTracing,
} from "@reader/api/rag-shadow";

startLangfuseTracing("reader-worker");

const worker = new Worker<BookProcessingJobData>(
    BOOK_PROCESSING_QUEUE_NAME,
    (job) => processBookProcessingJob(job),
    {
        connection: getRedisConnectionOptions(),
    }
);

const shadowWorker = new Worker<RagRerankShadowJobData>(
    RAG_RERANK_SHADOW_QUEUE_NAME,
    (job) => processRagRerankShadowJob(job),
    {
        connection: getRedisConnectionOptions(),
        concurrency: RAG_RERANK_SHADOW_CONCURRENCY,
        limiter: {
            max: parseRagRerankShadowRateLimit(
                process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE
            ),
            duration: 60_000,
        },
    }
);

worker.on("completed", (job) => {
    console.log(`Book processing job ${job.id} completed`);
});

worker.on("failed", (job, error) => {
    console.error(`Book processing job ${job?.id ?? "unknown"} failed`, error);
});

shadowWorker.on("completed", (job) => {
    console.log(`RAG shadow job ${job.id} completed`);
});

shadowWorker.on("failed", (job, error) => {
    console.error(
        "RAG shadow job failed",
        getRagShadowFailureMetadata(job, error)
    );
});

const shutdown = async () => {
    console.log("Shutting down book processing worker");
    await Promise.all([worker.close(), shadowWorker.close()]);
    await Promise.all([shutdownLangfuseTracing(), closeDatabasePool()]);
    process.exit(0);
};

process.on("SIGTERM", () => {
    void shutdown();
});

process.on("SIGINT", () => {
    void shutdown();
});

console.log(
    `Book processing worker listening on ${BOOK_PROCESSING_QUEUE_NAME}`
);
console.log(`RAG shadow worker listening on ${RAG_RERANK_SHADOW_QUEUE_NAME}`);
