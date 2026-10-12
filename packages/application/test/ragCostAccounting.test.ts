import assert from "node:assert/strict";
import test from "node:test";
import {
    AI_PRICING_VERSION,
    estimateModelCost,
    normalizeModelUsage,
} from "../src/rag/policies/costAccounting";

test("cached-token pricing matches every priced model and source version", () => {
    const usage = normalizeModelUsage({
        prompt_tokens: 1_000_000,
        completion_tokens: 10_000,
        total_tokens: 1_010_000,
        prompt_tokens_details: { cached_tokens: 250_000 },
    });
    assert.deepEqual(usage, {
        inputTokens: 1_000_000,
        cachedInputTokens: 250_000,
        outputTokens: 10_000,
        totalTokens: 1_010_000,
    });

    const expected = [
        [
            "gpt-4o-mini",
            0.13725,
            "https://developers.openai.com/api/docs/models/gpt-4o-mini",
        ],
        [
            "gpt-4o-mini-2024-07-18",
            0.13725,
            "https://developers.openai.com/api/docs/models/gpt-4o-mini",
        ],
        [
            "gpt-5.4-mini-2026-03-17",
            0.62625,
            "https://openai.com/index/introducing-gpt-5-4-mini-and-nano/",
        ],
        [
            "gpt-5.5-2026-04-23",
            4.175,
            "https://openai.com/index/introducing-gpt-5-5/",
        ],
    ] as const;

    for (const [model, amount, sourceUrl] of expected) {
        assert.deepEqual(estimateModelCost(model, usage), {
            currency: "USD",
            amount,
            pricingVersion: AI_PRICING_VERSION,
            sourceUrl,
        });
    }
});
