import { createHash } from "node:crypto";
import { Queue, type JobsOptions, type QueueOptions } from "bullmq";

export const BOOK_PROCESSING_QUEUE_NAME = "book-processing";
export const RAG_RERANK_SHADOW_QUEUE_NAME = "rag-rerank-shadow";
export const RAG_RERANK_SHADOW_CONCURRENCY = 2;
export const DEFAULT_RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE = 30;

export type BookFileType = "epub" | "pdf";

export interface BookProcessingJobData {
    bookId: string;
    userId: string;
    fileKey: string;
    fileType: BookFileType;
}

export type BookProcessingQueue = Queue<BookProcessingJobData>;

export interface RagRerankShadowJobData {
    assistantMessageId: string;
    userMessageId: string;
    conversationId: string;
    bookId: string;
    userId: string;
}

export type RagRerankShadowQueue = Queue<RagRerankShadowJobData>;

const defaultJobOptions: JobsOptions = {
    attempts: 3,
    backoff: {
        type: "exponential",
        delay: 5000,
    },
    removeOnComplete: {
        age: 24 * 60 * 60,
        count: 1000,
    },
    removeOnFail: {
        age: 7 * 24 * 60 * 60,
        count: 5000,
    },
};

const shadowJobOptions: JobsOptions = {
    attempts: 1,
    removeOnComplete: {
        age: 7 * 24 * 60 * 60,
        count: 5000,
    },
    removeOnFail: {
        age: 30 * 24 * 60 * 60,
        count: 10000,
    },
};

export const getRedisConnectionOptions = () => {
    if (!process.env.REDIS_URL) {
        throw new Error("Missing required REDIS_URL environment variable");
    }

    return {
        url: process.env.REDIS_URL,
        maxRetriesPerRequest: null,
    };
};

export const getRedisProducerConnectionOptions = () => ({
    ...getRedisConnectionOptions(),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
});

export const createBookProcessingQueue = (
    options: Omit<QueueOptions, "connection" | "defaultJobOptions"> = {}
) =>
    new Queue<BookProcessingJobData>(BOOK_PROCESSING_QUEUE_NAME, {
        ...options,
        connection: getRedisConnectionOptions(),
        defaultJobOptions,
    });

export const createBookProcessingJobId = (bookId: string) =>
    `book-processing-${bookId}`;

export const enqueueBookProcessingJob = async (
    queue: BookProcessingQueue,
    payload: BookProcessingJobData
) => {
    await queue.add("process-book", payload, {
        jobId: createBookProcessingJobId(payload.bookId),
    });
};

export const createRagRerankShadowQueue = (
    options: Omit<QueueOptions, "connection" | "defaultJobOptions"> = {}
) =>
    new Queue<RagRerankShadowJobData>(RAG_RERANK_SHADOW_QUEUE_NAME, {
        ...options,
        connection: getRedisProducerConnectionOptions(),
        defaultJobOptions: shadowJobOptions,
    });

export const createRagRerankShadowJobId = (assistantMessageId: string) =>
    `rag-rerank-shadow-${assistantMessageId}`;

export const enqueueRagRerankShadowJob = async (
    queue: RagRerankShadowQueue,
    payload: RagRerankShadowJobData
) => {
    await queue.add("compare-reranked-evidence", payload, {
        jobId: createRagRerankShadowJobId(payload.assistantMessageId),
    });
};

export const parseRagRerankShadowSampleRate = (
    value: string | undefined
) => {
    if (value === undefined || value === "") return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        throw new Error(
            "RAG_RERANK_SHADOW_SAMPLE_RATE must be a number from 0 to 1"
        );
    }
    return parsed;
};

export const parseRagRerankShadowRateLimit = (
    value: string | undefined
) => {
    if (value === undefined || value === "") {
        return DEFAULT_RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(
            "RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE must be a positive integer"
        );
    }
    return parsed;
};

export const getRagRerankShadowSampleBucket = (
    assistantMessageId: string
) => {
    const digest = createHash("sha256")
        .update(assistantMessageId)
        .digest();
    return digest.readUInt32BE(0) / 0x1_0000_0000;
};

export const shouldSampleRagRerankShadow = (
    assistantMessageId: string,
    sampleRate: number
) => {
    if (sampleRate <= 0) return false;
    if (sampleRate >= 1) return true;
    return getRagRerankShadowSampleBucket(assistantMessageId) < sampleRate;
};
