import assert from "node:assert/strict";
import test from "node:test";
import type { RagShadowResult } from "@reader/domain";
import {
    ProcessRagShadowComparison,
    RagShadowAuthorizationError,
    compareShadowSourceRanks,
    type RagShadowJob,
    type RagShadowRecords,
    type RagTracing,
    type RagShadowTracing,
} from "../src";

const payload: RagShadowJob = {
    assistantMessageId: "assistant-1",
    userMessageId: "user-1",
    conversationId: "conversation-1",
    bookId: "book-1",
    userId: "user-1",
};

const baselineMetadata = {
    pipelineVersion: "baseline-rag-v1",
    langfuseTraceId: "baseline-trace",
};

const records = (): RagShadowRecords => ({
    assistant: {
        id: payload.assistantMessageId,
        role: "assistant",
        conversationId: payload.conversationId,
        contextSources: [
            {
                id: "chunk-a",
                chunkIndex: 1,
                score: 1,
                bestRank: 1,
                excerpt: "private baseline",
            },
        ],
        executionMetadata: baselineMetadata,
    },
    userMessage: {
        id: payload.userMessageId,
        role: "user",
        conversationId: payload.conversationId,
        content: "private query",
    },
    conversation: {
        id: payload.conversationId,
        userId: payload.userId,
        resourceType: "book",
        resourceId: payload.bookId,
    },
    book: { id: payload.bookId, userId: payload.userId },
});

const trace: RagTracing = {
    traceId: "candidate-trace",
    startObservation: () => trace,
    update: () => undefined,
    end: () => undefined,
};

const tracing: RagShadowTracing = {
    withShadowTrace: async (_context, callback) => callback(trace),
    contentFree: (value) => value,
};

const retrieval = {
    async execute() {
        return {
            status: "ready" as const,
            sources: [
                {
                    id: "chunk-b",
                    chunkIndex: 2,
                    score: 0.8,
                    bestRank: 1,
                    excerpt: "private candidate",
                },
            ],
            telemetry: {
                pipelineVersion: "rerank-rag-v1" as const,
                promptVersion: "book-context-v1",
                queryPlan: null,
                retrieval: {
                    mode: "reranked" as const,
                    durationMs: 12,
                    firstStage: {} as never,
                    firstStageCandidates: [],
                    finalCandidates: [],
                    reranker: {
                        requestedModel: "reranker",
                        resolvedModel: "reranker",
                        promptVersion: "rerank-documents-v1",
                        status: "success" as const,
                        durationMs: 8,
                        usage: null,
                        estimatedCost: null,
                        fallbackReason: null,
                    },
                    diversity: { maxWordTrigramJaccard: 0.2 },
                },
            },
        };
    },
};

const createProcess = (
    repository: {
        load: () => Promise<RagShadowRecords>;
        persist: (id: string, result: RagShadowResult) => Promise<boolean>;
    } = {
        load: async () => records(),
        persist: async () => true,
    }
) =>
    new ProcessRagShadowComparison({
        repository,
        retrieval,
        tracing,
        clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

test("shadow replay skips retrieval after authorization and completion checks", async () => {
    let retrieved = 0;
    const process = new ProcessRagShadowComparison({
        repository: {
            load: async () => ({
                ...records(),
                assistant: {
                    ...records().assistant!,
                    executionMetadata: {
                        ...baselineMetadata,
                        shadow: {} as never,
                    },
                },
            }),
            persist: async () => true,
        },
        retrieval: {
            execute: async () => {
                retrieved += 1;
                return retrieval.execute();
            },
        },
        tracing,
        clock: { now: () => new Date() },
    });
    assert.deepEqual(await process.execute({ payload }), {
        status: "already_completed",
    });
    assert.equal(retrieved, 0);
});

test("shadow rejects identifier and role mismatches before retrieval", async () => {
    const current = records();
    current.assistant!.role = "user";
    let retrieved = false;
    const process = new ProcessRagShadowComparison({
        repository: {
            load: async () => current,
            persist: async () => true,
        },
        retrieval: {
            execute: async () => {
                retrieved = true;
                return retrieval.execute();
            },
        },
        tracing,
        clock: { now: () => new Date() },
    });
    await assert.rejects(
        process.execute({ payload }),
        RagShadowAuthorizationError
    );
    assert.equal(retrieved, false);
});

test("shadow only compares baseline assistant messages", async () => {
    const current = records();
    current.assistant!.executionMetadata = {
        pipelineVersion: "rerank-rag-v1",
    };
    let retrieved = false;
    const process = new ProcessRagShadowComparison({
        repository: {
            load: async () => current,
            persist: async () => true,
        },
        retrieval: {
            execute: async () => {
                retrieved = true;
                return retrieval.execute();
            },
        },
        tracing,
        clock: { now: () => new Date() },
    });
    assert.deepEqual(await process.execute({ payload }), {
        status: "not_baseline",
    });
    assert.equal(retrieved, false);
});

test("concurrent shadow workers have one first-writer-wins result", async () => {
    let writes = 0;
    let stored = false;
    const process = createProcess({
        load: async () => records(),
        persist: async () => {
            writes += 1;
            if (stored) return false;
            stored = true;
            return true;
        },
    });
    const results = await Promise.all([
        process.execute({ payload }),
        process.execute({ payload }),
    ]);
    assert.equal(
        results.filter((result) => result.status === "completed").length,
        1
    );
    assert.equal(
        results.filter((result) => result.status === "already_completed")
            .length,
        1
    );
    assert.equal(writes, 2);
});

test("shadow comparison policy is deterministic", () => {
    assert.deepEqual(
        compareShadowSourceRanks(
            [
                { id: "a", rank: 1 },
                { id: "b", rank: 2 },
            ],
            [
                { id: "b", rank: 1 },
                { id: "c", rank: 2 },
            ]
        ),
        {
            overlapCount: 1,
            sourceSetJaccard: 1 / 3,
            exactRankMatches: 0,
            identical: false,
        }
    );
});
