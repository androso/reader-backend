import type { Job } from "bullmq";
import type { BookProcessingJobData } from "@reader/jobs";
import type { RagRerankShadowJobData } from "@reader/jobs";
import type { ProcessBookResult } from "@reader/processing";
import { createLogger } from "@reader/providers";

const log = createLogger("worker");

export type ProcessUploadedBook = (
    payload: BookProcessingJobData,
    options?: { markFailedOnError?: boolean }
) => Promise<ProcessBookResult>;

const loadProcessUploadedBook = (): ProcessUploadedBook => {
    log.debug("Loading processUploadedBook from built API module");
    const module = require("@reader/api/book-processing");
    log.debug("Loaded processUploadedBook");
    return module.processUploadedBook as ProcessUploadedBook;
};

export const processBookProcessingJob = async (
    job: Pick<
        Job<BookProcessingJobData>,
        "attemptsMade" | "data" | "opts" | "id"
    >,
    processBook: ProcessUploadedBook = loadProcessUploadedBook()
) => {
    const start = Date.now();
    const maxAttempts =
        typeof job.opts.attempts === "number" && job.opts.attempts > 0
            ? job.opts.attempts
            : 1;
    const isFinalAttempt = job.attemptsMade + 1 >= maxAttempts;

    log.info("Processing book job", {
        jobId: job.id,
        bookId: job.data.bookId,
        userId: job.data.userId,
        fileKey: job.data.fileKey,
        fileType: job.data.fileType,
        attemptsMade: job.attemptsMade,
        maxAttempts,
        isFinalAttempt,
    });

    try {
        const result = await processBook(job.data, {
            markFailedOnError: isFinalAttempt,
        });
        const duration = Date.now() - start;
        log.info("Book job completed successfully", {
            jobId: job.id,
            bookId: job.data.bookId,
            collectionName: result.collectionName,
            chunkCount: result.chunks,
            reusedCollection: result.reusedCollection,
            durationMs: duration,
        });
    } catch (error) {
        const duration = Date.now() - start;
        log.error("Book job failed", {
            jobId: job.id,
            bookId: job.data.bookId,
            userId: job.data.userId,
            fileKey: job.data.fileKey,
            attemptsMade: job.attemptsMade,
            maxAttempts,
            isFinalAttempt,
            durationMs: duration,
            error: error instanceof Error ? error.message : String(error),
        });
        throw error;
    }
};

export type ProcessRagRerankShadow = (
    payload: RagRerankShadowJobData
) => Promise<{ status: string }>;

export const getRagShadowFailureMetadata = (
    job: Pick<Job<RagRerankShadowJobData>, "id"> | undefined,
    error: unknown
) => ({
    jobId: job?.id ?? "unknown",
    errorName: error instanceof Error ? error.name : typeof error,
});

const loadProcessRagRerankShadow = (): ProcessRagRerankShadow => {
    const module = require("@reader/api/rag-shadow");
    return module.processRagRerankShadow as ProcessRagRerankShadow;
};

export const processRagRerankShadowJob = async (
    job: Pick<Job<RagRerankShadowJobData>, "data" | "id">,
    processShadow: ProcessRagRerankShadow = loadProcessRagRerankShadow()
) => {
    const start = Date.now();
    log.info("Processing RAG shadow job", {
        jobId: job.id,
        assistantMessageId: job.data.assistantMessageId,
        conversationId: job.data.conversationId,
        bookId: job.data.bookId,
    });
    try {
        const result = await processShadow(job.data);
        log.info("RAG shadow job completed", {
            jobId: job.id,
            assistantMessageId: job.data.assistantMessageId,
            conversationId: job.data.conversationId,
            bookId: job.data.bookId,
            status: result.status,
            durationMs: Date.now() - start,
        });
        return result;
    } catch (error) {
        log.error("RAG shadow job failed", {
            ...getRagShadowFailureMetadata(job, error),
            assistantMessageId: job.data.assistantMessageId,
            conversationId: job.data.conversationId,
            bookId: job.data.bookId,
            durationMs: Date.now() - start,
        });
        throw error;
    }
};
