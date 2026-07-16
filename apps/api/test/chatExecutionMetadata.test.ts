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
                vectorCandidates: [
                    { id: "chunk_1", rank: 1, distance: 0.1 },
                ],
                selectedCandidates: [
                    { id: "chunk_1", rank: 1, score: 0.03 },
                ],
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
    assert.equal(metadata.langfuseTraceId, "trace-1");
    assert.equal(
        "excerpt" in metadata.retrieval!.selectedCandidates[0],
        false
    );
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
