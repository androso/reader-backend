import assert from "node:assert/strict";
import test from "node:test";
import type { RagRerankShadowJobData } from "@reader/jobs";
import {
    compareShadowSourceRanks,
    processRagRerankShadow,
    RagShadowAuthorizationError,
    validateRagShadowRecords,
    type RagShadowDependencies,
    type RagShadowRecords,
} from "../src/services/RagShadowService";

const payload: RagRerankShadowJobData = {
    assistantMessageId: "assistant-1",
    userMessageId: "user-message-1",
    conversationId: "conversation-1",
    bookId: "book-1",
    userId: "user-1",
};

const executionMetadata = {
    pipelineVersion: "baseline-rag-v1",
    promptVersion: "book-context-v1",
    pricingVersion: "pricing-v1",
    modelVersion: "gpt-4o-mini",
    queryPlan: null,
    retrieval: null,
    generation: {
        durationMs: 10,
        usage: null,
        estimatedCost: null,
    },
    retrievalCost: null,
    combinedCost: null,
    totalLatencyMs: 20,
    langfuseTraceId: "baseline-trace",
} as const;

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
                excerpt: "baseline excerpt",
            },
            {
                id: "chunk-b",
                chunkIndex: 2,
                score: 0.9,
                bestRank: 2,
                excerpt: "baseline excerpt two",
            },
        ],
        executionMetadata,
    },
    userMessage: {
        id: payload.userMessageId,
        role: "user",
        conversationId: payload.conversationId,
        content: "What happened?",
    },
    conversation: {
        id: payload.conversationId,
        userId: payload.userId,
        resourceType: "book",
        resourceId: payload.bookId,
    },
    book: { id: payload.bookId, userId: payload.userId },
});

const retrievalResult = (status: "success" | "fallback" = "success") =>
    ({
        status: "ready",
        sources: [
            {
                id: "chunk-b",
                chunkIndex: 2,
                score: 0.9,
                bestRank: 2,
                excerpt: "candidate excerpt",
            },
            {
                id: "chunk-c",
                chunkIndex: 3,
                score: 0.8,
                bestRank: 3,
                excerpt: "candidate excerpt two",
            },
        ],
        telemetry: {
            pipelineVersion: "rerank-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "reranked",
                durationMs: 400,
                firstStage: {},
                firstStageCandidates: [],
                finalCandidates: [],
                reranker: {
                    requestedModel: "gpt-5.4-mini-2026-03-17",
                    resolvedModel:
                        status === "success" ? "gpt-5.4-mini-2026-03-17" : null,
                    promptVersion: "rerank-documents-v1",
                    status,
                    durationMs: 300,
                    usage: null,
                    estimatedCost: null,
                    fallbackReason: status === "fallback" ? "timeout" : null,
                },
                diversity: { maxWordTrigramJaccard: 0.2 },
            },
        },
    }) as any;

const dependencies = (
    overrides: Partial<RagShadowDependencies> = {}
): RagShadowDependencies => ({
    load: async () => records(),
    retrieve: async () => retrievalResult(),
    persist: async () => true,
    ...overrides,
});

test("source comparison handles empty and reordered evidence deterministically", () => {
    assert.deepEqual(compareShadowSourceRanks([], []), {
        overlapCount: 0,
        sourceSetJaccard: 1,
        exactRankMatches: 0,
        identical: true,
    });
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

test("missing shadow records are skipped before retrieval", async () => {
    let retrieved = false;
    const result = await processRagRerankShadow(
        payload,
        dependencies({
            load: async () => ({ ...records(), book: null }),
            retrieve: async () => {
                retrieved = true;
                return retrievalResult();
            },
        })
    );
    assert.deepEqual(result, { status: "missing" });
    assert.equal(retrieved, false);
});

test("existing shadow metadata is idempotently skipped", async () => {
    const current = records();
    current.assistant!.executionMetadata = {
        ...executionMetadata,
        shadow: {} as any,
    };
    let retrieved = false;
    const result = await processRagRerankShadow(
        payload,
        dependencies({
            load: async () => current,
            retrieve: async () => {
                retrieved = true;
                return retrievalResult();
            },
        })
    );
    assert.deepEqual(result, { status: "already_completed" });
    assert.equal(retrieved, false);
});

test("every ownership and scope mismatch is rejected before retrieval", async () => {
    const invalidRecords: Array<[string, (value: RagShadowRecords) => void]> = [
        ["assistant role", (value) => (value.assistant!.role = "user")],
        [
            "assistant conversation",
            (value) => (value.assistant!.conversationId = "other"),
        ],
        ["user role", (value) => (value.userMessage!.role = "assistant")],
        [
            "user conversation",
            (value) => (value.userMessage!.conversationId = "other"),
        ],
        [
            "conversation owner",
            (value) => (value.conversation!.userId = "other"),
        ],
        [
            "conversation resource type",
            (value) => (value.conversation!.resourceType = "article"),
        ],
        [
            "conversation resource",
            (value) => (value.conversation!.resourceId = "other"),
        ],
        ["book owner", (value) => (value.book!.userId = "other")],
    ];

    for (const [name, mutate] of invalidRecords) {
        const current = records();
        mutate(current);
        assert.throws(
            () => validateRagShadowRecords(payload, current),
            RagShadowAuthorizationError,
            name
        );
    }
});

test("successful shadow retrieval persists compact comparison metadata", async () => {
    const persisted: unknown[] = [];
    const queries: string[] = [];
    const result = await processRagRerankShadow(
        payload,
        dependencies({
            retrieve: async (options) => {
                queries.push(options.query);
                return retrievalResult();
            },
            persist: async (messageId, shadow) => {
                persisted.push({ messageId, shadow });
                return true;
            },
        })
    );

    assert.equal(result.status, "completed");
    assert.deepEqual(queries, ["What happened?"]);
    assert.equal(persisted.length, 1);
    assert.deepEqual(result.shadow.comparison, {
        overlapCount: 1,
        sourceSetJaccard: 1 / 3,
        exactRankMatches: 0,
        identical: false,
    });
    assert.equal(result.shadow.candidate.reranker.status, "success");
    assert.equal(JSON.stringify(result.shadow).includes("excerpt"), false);
    assert.equal(
        JSON.stringify(result.shadow).includes("What happened"),
        false
    );
});

test("reranker fallback is persisted as a completed comparison", async () => {
    const result = await processRagRerankShadow(
        payload,
        dependencies({ retrieve: async () => retrievalResult("fallback") })
    );
    assert.equal(result.status, "completed");
    assert.equal(result.shadow.candidate.reranker.status, "fallback");
    assert.equal(result.shadow.candidate.reranker.fallbackReason, "timeout");
});

test("retrieval infrastructure errors fail the one-attempt job", async () => {
    await assert.rejects(
        processRagRerankShadow(
            payload,
            dependencies({
                retrieve: async () => {
                    throw new Error("chroma unavailable");
                },
            })
        ),
        /chroma unavailable/
    );
});

test("a book deleted after authorization is a benign missing result", async () => {
    const result = await processRagRerankShadow(
        payload,
        dependencies({
            retrieve: async () => ({
                status: "not_found",
                sources: null,
                telemetry: {
                    pipelineVersion: "rerank-rag-v1",
                    promptVersion: "book-context-v1",
                    queryPlan: null,
                    retrieval: null,
                },
            }),
        })
    );
    assert.deepEqual(result, { status: "missing" });
});

test("a lost JSONB race reports already completed", async () => {
    const result = await processRagRerankShadow(
        payload,
        dependencies({ persist: async () => false })
    );
    assert.equal(result.status, "already_completed");
});
