import assert from "node:assert/strict";
import test from "node:test";
import {
    buildMessageExecutionMetadata,
    PUBLIC_MESSAGE_SELECTION,
} from "../src/services/ChatExecutionMetadata";

test("builds compact durable execution metadata", () => {
    const metadata = buildMessageExecutionMetadata({
        telemetry: {
            pipelineVersion: "baseline-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "hybrid",
                durationMs: 12,
                lexicalCandidates: [{ id: "chunk_1", rank: 1 }],
                vectorCandidates: [{ id: "chunk_1", rank: 1, distance: 0.1 }],
                selectedCandidates: [{ id: "chunk_1", rank: 1, score: 0.03 }],
            },
        },
        model: "gpt-4o-mini",
        usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
        },
        generationDurationMs: 25,
        totalLatencyMs: 40,
        langfuseTraceId: "trace-1",
    });

    assert.equal(metadata.pipelineVersion, "baseline-rag-v1");
    assert.equal(metadata.generation.usage?.totalTokens, 120);
    assert.equal(metadata.generation.estimatedCost?.amount, 0.000027);
    assert.equal(metadata.retrievalCost, null);
    assert.equal(metadata.combinedCost?.amount, 0.000027);
    assert.equal(metadata.langfuseTraceId, "trace-1");
    assert.equal(metadata.retrieval?.mode, "hybrid");
    if (metadata.retrieval?.mode === "hybrid") {
        assert.equal(
            "excerpt" in metadata.retrieval.selectedCandidates[0],
            false
        );
    }
});

test("adds reranker retrieval and combined costs to private metadata", () => {
    const metadata = buildMessageExecutionMetadata({
        telemetry: {
            pipelineVersion: "rerank-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "reranked",
                durationMs: 20,
                firstStage: {
                    mode: "hybrid",
                    durationMs: 5,
                    lexicalCandidates: [],
                    vectorCandidates: [],
                    selectedCandidates: [],
                },
                firstStageCandidates: [],
                finalCandidates: [],
                reranker: {
                    requestedModel: "gpt-5.4-mini-2026-03-17",
                    resolvedModel: "gpt-5.4-mini-2026-03-17",
                    promptVersion: "rerank-documents-v1",
                    status: "success",
                    durationMs: 15,
                    usage: {
                        inputTokens: 100,
                        cachedInputTokens: 0,
                        outputTokens: 10,
                        totalTokens: 110,
                    },
                    estimatedCost: {
                        currency: "USD",
                        amount: 0.00012,
                        pricingVersion: "openai-standard-2026-07-16",
                        sourceUrl: "https://example.com/pricing",
                    },
                    fallbackReason: null,
                },
                diversity: { maxWordTrigramJaccard: 0.2 },
            },
        },
        model: "gpt-4o-mini",
        usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
        },
        generationDurationMs: 25,
        totalLatencyMs: 50,
    });
    assert.equal(metadata.retrievalCost?.amount, 0.00012);
    assert.equal(metadata.combinedCost?.amount, 0.000147);
    assert.equal("executionMetadata" in PUBLIC_MESSAGE_SELECTION, false);
});

test("treats skipped reranker cost as known zero", () => {
    const metadata = buildMessageExecutionMetadata({
        telemetry: {
            pipelineVersion: "rerank-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: {
                mode: "reranked",
                durationMs: 2,
                firstStage: {
                    mode: "hybrid",
                    durationMs: 2,
                    lexicalCandidates: [],
                    vectorCandidates: [],
                    selectedCandidates: [],
                },
                firstStageCandidates: [],
                finalCandidates: [],
                reranker: {
                    requestedModel: "gpt-5.4-mini-2026-03-17",
                    resolvedModel: null,
                    promptVersion: "rerank-documents-v1",
                    status: "skipped",
                    durationMs: 0,
                    usage: null,
                    estimatedCost: null,
                    fallbackReason: "no_candidates",
                },
                diversity: { maxWordTrigramJaccard: 0 },
            },
        },
        model: "gpt-4o-mini",
        usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
        },
        generationDurationMs: 1,
        totalLatencyMs: 3,
    });
    assert.equal(metadata.retrievalCost, null);
    assert.equal(metadata.combinedCost?.amount, 0.000027);
});

test("public conversation message projection excludes execution metadata", () => {
    assert.equal("executionMetadata" in PUBLIC_MESSAGE_SELECTION, false);
    assert.deepEqual(Object.keys(PUBLIC_MESSAGE_SELECTION), [
        "id",
        "conversationId",
        "role",
        "content",
        "contextSources",
        "completionStatus",
        "finishReason",
        "createdAt",
    ]);
});

test("missing usage and traces remain nullable", () => {
    const metadata = buildMessageExecutionMetadata({
        telemetry: {
            pipelineVersion: "baseline-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: null,
        },
        model: "unknown-model",
        usage: null,
        generationDurationMs: 1,
        totalLatencyMs: 2,
    });

    assert.equal(metadata.generation.usage, null);
    assert.equal(metadata.generation.estimatedCost, null);
    assert.equal(metadata.langfuseTraceId, null);
});

test("persists the resolved model version used for pricing", () => {
    const metadata = buildMessageExecutionMetadata({
        telemetry: {
            pipelineVersion: "baseline-rag-v1",
            promptVersion: "book-context-v1",
            queryPlan: null,
            retrieval: null,
        },
        model: "gpt-4o-mini-2024-07-18",
        usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
        },
        generationDurationMs: 1,
        totalLatencyMs: 2,
    });

    assert.equal(metadata.modelVersion, "gpt-4o-mini-2024-07-18");
});
