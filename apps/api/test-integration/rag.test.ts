import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { eq } from "drizzle-orm";
import { Test } from "@nestjs/testing";
import {
    ProcessRagShadowComparison,
    type RagShadowJob,
    type RagShadowTracing,
} from "@reader/application";
import {
    createRagRerankShadowQueue,
    enqueueRagRerankShadowJob,
} from "@reader/jobs";
import { db, pool } from "../src/db";
import { Books, Conversations, Messages, Users } from "../src/db/schema";
import { createDrizzleRagShadowRepository } from "../src/infrastructure/rag/shadowRepository";

const root = resolve(__dirname, "../../..");
const userIds: string[] = [];
const bookIds: string[] = [];
const conversationIds: string[] = [];
const messageIds: string[] = [];

const baselineMetadata = {
    pipelineVersion: "baseline-rag-v1",
    promptVersion: "book-context-v1",
    pricingVersion: "pricing-v1",
    modelVersion: "gpt-4o-mini",
    queryPlan: null,
    retrieval: null,
    generation: {
        durationMs: 1,
        usage: null,
        estimatedCost: null,
    },
    retrievalCost: null,
    combinedCost: null,
    totalLatencyMs: 1,
    langfuseTraceId: "baseline-trace",
};

const retrievalResult = () =>
    ({
        status: "ready",
        sources: [
            {
                id: "candidate-chunk",
                chunkIndex: 2,
                score: 0.9,
                bestRank: 1,
                excerpt: "candidate excerpt",
            },
        ],
        telemetry: {
            pipelineVersion: "rerank-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "reranked",
                durationMs: 3,
                firstStage: {},
                firstStageCandidates: [],
                finalCandidates: [],
                reranker: {
                    requestedModel: "gpt-5.4-mini-2026-03-17",
                    resolvedModel: "gpt-5.4-mini-2026-03-17",
                    promptVersion: "rerank-documents-v1",
                    status: "success",
                    durationMs: 2,
                    usage: null,
                    estimatedCost: null,
                    fallbackReason: null,
                },
                diversity: { maxWordTrigramJaccard: 0.2 },
            },
        },
    }) as any;

const tracing: RagShadowTracing = {
    withShadowTrace: async (_context, callback) =>
        callback({
            traceId: "candidate-trace",
            startObservation: () => undefined as never,
            update: () => undefined,
            end: () => undefined,
        } as any),
    contentFree: (trace) => trace,
};

const seedCase = async (ownerId = randomUUID()) => {
    userIds.push(ownerId);
    const bookId = randomUUID();
    const conversationId = randomUUID();
    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    bookIds.push(bookId);
    conversationIds.push(conversationId);
    messageIds.push(userMessageId, assistantMessageId);

    await db.insert(Users).values({
        id: ownerId,
        email: `${ownerId}@integration.test`,
        name: "RAG integration user",
    });
    await db.insert(Books).values({
        id: bookId,
        userId: ownerId,
        title: "RAG integration book",
        fileKey: `rag-${bookId}.epub`,
        fileType: "epub",
        collectionName: `rag-${bookId}`,
        processingStatus: "completed",
    });
    await db.insert(Conversations).values({
        id: conversationId,
        userId: ownerId,
        title: "RAG integration",
        resourceType: "book",
        resourceId: bookId,
    });
    await db.insert(Messages).values([
        {
            id: userMessageId,
            conversationId,
            role: "user",
            content: "What happened?",
        },
        {
            id: assistantMessageId,
            conversationId,
            role: "assistant",
            content: "Baseline answer",
            contextSources: [
                {
                    id: "baseline-chunk",
                    chunkIndex: 1,
                    score: 1,
                    bestRank: 1,
                    excerpt: "baseline excerpt",
                },
            ],
            completionStatus: "complete",
            finishReason: "stop",
            executionMetadata: baselineMetadata,
        },
    ]);

    return {
        payload: {
            userId: ownerId,
            conversationId,
            bookId,
            userMessageId,
            assistantMessageId,
        } satisfies RagShadowJob,
        assistantMessageId,
    };
};

const createProcess = (retrieve: (input: unknown) => Promise<unknown>) => {
    const repository = createDrizzleRagShadowRepository(db);
    return new ProcessRagShadowComparison({
        repository,
        retrieval: { execute: retrieve as never },
        tracing,
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });
};

const readShadow = async (assistantMessageId: string) => {
    const [message] = await db
        .select({ executionMetadata: Messages.executionMetadata })
        .from(Messages)
        .where(eq(Messages.id, assistantMessageId));
    return (message?.executionMetadata as any)?.shadow;
};

const waitForShadow = async (assistantMessageId: string) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        const shadow = await readShadow(assistantMessageId);
        if (shadow) return shadow;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Timed out waiting for worker shadow persistence");
};

test("retrieval ownership rejects another user's book", async () => {
    const seeded = await seedCase();
    const attackerId = randomUUID();
    userIds.push(attackerId);
    await db.insert(Users).values({
        id: attackerId,
        email: `${attackerId}@integration.test`,
        name: "RAG attacker",
    });
    const process = createProcess(async () => {
        throw new Error("retrieval should not run");
    });
    await assert.rejects(
        process.execute({
            payload: { ...seeded.payload, userId: attackerId },
        }),
        /authorized book conversation/
    );
    assert.equal(await readShadow(seeded.assistantMessageId), undefined);
});

test("shadow persistence, replay, and concurrent workers write exactly once", async () => {
    const seeded = await seedCase();
    let retrievalCalls = 0;
    const process = createProcess(async () => {
        retrievalCalls += 1;
        return retrievalResult();
    });

    const completed = await process.execute({ payload: seeded.payload });
    assert.equal(completed.status, "completed");
    assert.ok(await readShadow(seeded.assistantMessageId));
    const replay = await process.execute({ payload: seeded.payload });
    assert.equal(replay.status, "already_completed");
    assert.equal(retrievalCalls, 1);

    const concurrent = await seedCase();
    let calls = 0;
    let release!: () => void;
    const bothRetrieved = new Promise<void>((resolve) => {
        release = resolve;
    });
    const concurrentProcess = createProcess(async () => {
        calls += 1;
        if (calls === 2) release();
        await bothRetrieved;
        return retrievalResult();
    });
    const resultsPromise = Promise.all([
        concurrentProcess.execute({ payload: concurrent.payload }),
        concurrentProcess.execute({ payload: concurrent.payload }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (calls < 2) release();
    const results = await resultsPromise;
    assert.equal(
        results.filter((result) => result.status === "completed").length,
        1
    );
    assert.equal(
        results.filter((result) => result.status === "already_completed")
            .length,
        1
    );
    assert.ok(await readShadow(concurrent.assistantMessageId));
});

test("the worker module processes a shadow job through the API barrel with fakes", async () => {
    const seeded = await seedCase();
    const apiModulePath = require.resolve("@reader/api/rag-shadow");
    const originalApiExports = require(apiModulePath);
    const apiModuleCache = require.cache[apiModulePath]!;
    const apiShadow = originalApiExports as any;
    const originalProcess = apiShadow.processRagRerankShadow;
    const repository = createDrizzleRagShadowRepository(db);
    apiModuleCache.exports = {
        ...apiShadow,
        processRagRerankShadow: (payload: RagShadowJob) =>
            originalProcess(
                payload,
                {
                    load: repository.load,
                    retrieve: async () => retrievalResult(),
                    persist: repository.persist,
                },
                undefined
            ),
    };

    const workerModule = require(
        resolve(root, "apps/worker/build/worker.module.js")
    ) as any;
    const workerProcessor = require(
        resolve(root, "apps/worker/build/processor.js")
    ) as any;
    const { WORKER_RESOURCES, WORKER_RUNTIME_DEPENDENCIES } = workerModule;
    const context = await Test.createTestingModule({
        imports: [workerModule.WorkerModule],
    })
        .overrideProvider(WORKER_RUNTIME_DEPENDENCIES)
        .useValue({
            processBookProcessingJob: async () => undefined,
            processRagRerankShadowJob:
                workerProcessor.processRagRerankShadowJob,
            getRedisConnectionOptions: () => ({
                url: process.env.REDIS_URL,
                maxRetriesPerRequest: null,
            }),
            getRagRerankShadowRateLimit: () => 30,
            logger: { log() {}, error() {} },
        })
        .overrideProvider(WORKER_RESOURCES)
        .useValue({ startTracing() {}, close: async () => undefined })
        .compile();

    const queue = createRagRerankShadowQueue();
    try {
        await context.init();
        await enqueueRagRerankShadowJob(queue, seeded.payload);
        const shadow = await waitForShadow(seeded.assistantMessageId);
        assert.equal(shadow.version, "rag-shadow-v1");
    } finally {
        await queue.close();
        await context.close();
        apiModuleCache.exports = originalApiExports;
    }
});

after(async () => {
    if (messageIds.length) {
        await db.delete(Messages).where(eq(Messages.id, messageIds[0]!));
    }
    for (const conversationId of conversationIds) {
        await db
            .delete(Conversations)
            .where(eq(Conversations.id, conversationId));
    }
    for (const bookId of bookIds) {
        await db.delete(Books).where(eq(Books.id, bookId));
    }
    for (const userId of userIds) {
        await db.delete(Users).where(eq(Users.id, userId));
    }
    await pool.end();
});
