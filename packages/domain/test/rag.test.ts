import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_RAG_PIPELINE_VERSION,
    RAG_PIPELINES,
    RERANKER_MODELS,
    type ChatModelCost,
    type ChatModelUsage,
    type RagModelCost,
    type RagModelUsage,
} from "../src";

test("RAG pipeline data and model DTO aliases preserve current values", () => {
    assert.equal(DEFAULT_RAG_PIPELINE_VERSION, "baseline-rag-v1");
    assert.deepEqual(Object.keys(RAG_PIPELINES), [
        "baseline-rag-v1",
        "rerank-rag-v1",
    ]);
    assert.deepEqual(RERANKER_MODELS, {
        "gpt-5.4-mini-2026-03-17": "gpt-5.4-mini-2026-03-17",
    });

    const usage: RagModelUsage = {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 2,
        totalTokens: 3,
    };
    const cost: RagModelCost = {
        currency: "USD",
        amount: 0,
        pricingVersion: "test",
        sourceUrl: "https://example.com",
    };
    const chatUsage: ChatModelUsage = usage;
    const chatCost: ChatModelCost = cost;
    assert.equal(chatUsage, usage);
    assert.equal(chatCost, cost);
});
