import assert from "node:assert/strict";
import test from "node:test";
import {
    OPENAI_CHAT_MAX_TOKENS,
    OPENAI_CHAT_MODEL,
    OPENAI_CHAT_TEMPERATURE,
    OpenAIService,
    buildChatCompletionRequest,
    createOpenAIClientOptions,
    resolveStreamModelVersion,
    type ChatMessage,
} from "../src/services/OpenAIServices";
import {
    estimateModelCost,
    normalizeModelUsage,
} from "../src/services/AiUsage";
import { getRagPipeline } from "../src/services/RagPipeline";
import type OpenAI from "openai";

const messages: ChatMessage[] = [
    {
        role: "user",
        content: "What happened in chapter one?",
    },
];

const restoreEnv = (name: string, value: string | undefined) => {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
};

test("prefers the concrete model version from stream chunks", () => {
    assert.equal(
        resolveStreamModelVersion(
            "gpt-4o-mini",
            "gpt-4o-mini-2024-07-18"
        ),
        "gpt-4o-mini-2024-07-18"
    );
    assert.equal(
        resolveStreamModelVersion("gpt-4o-mini", undefined),
        "gpt-4o-mini"
    );
});

test("chat stream request includes usage capture and model settings", () => {
    const request = buildChatCompletionRequest(messages);

    assert.equal(request.model, OPENAI_CHAT_MODEL);
    assert.equal(request.temperature, OPENAI_CHAT_TEMPERATURE);
    assert.equal(request.max_tokens, OPENAI_CHAT_MAX_TOKENS);
    assert.equal(request.stream, true);
    assert.deepEqual(request.stream_options, { include_usage: true });
    assert.equal(request.messages.length, 2);
    assert.equal(request.messages[0].role, "system");
    assert.equal(request.messages[1].role, "user");
});

test("newer chat models use compatible request parameters", () => {
    for (const model of [
        "gpt-5.5-2026-04-23",
        "gpt-5.4-mini-2026-03-17",
    ] as const) {
        const request = buildChatCompletionRequest(messages, undefined, model);

        assert.equal(request.model, model);
        assert.equal(request.max_completion_tokens, OPENAI_CHAT_MAX_TOKENS);
        assert.equal(request.max_tokens, undefined);
        assert.equal(request.temperature, undefined);
        assert.equal(request.messages[0].role, "developer");
    }
});

test("chat stream request accepts deterministic temperature", () => {
    const request = buildChatCompletionRequest(
        messages,
        undefined,
        OPENAI_CHAT_MODEL,
        0
    );

    assert.equal(request.temperature, 0);
});

test("OpenAI client options preserve transport hardening", () => {
    const options = createOpenAIClientOptions();

    assert.equal(options.maxRetries, 0);
    assert.deepEqual(options.defaultHeaders, {
        "Accept-Encoding": "identity",
    });
    if (typeof globalThis.fetch === "function") {
        assert.equal(typeof options.fetch, "function");
    }
});

test("stream generation sends the usage-enabled request to the configured client", async () => {
    const previousPublicKey = process.env.LANGFUSE_PUBLIC_KEY;
    const previousSecretKey = process.env.LANGFUSE_SECRET_KEY;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;

    const calls: unknown[] = [];
    const fakeStream = {} as AsyncIterable<unknown>;
    const fakeClient = {
        chat: {
            completions: {
                create: async (request: unknown) => {
                    calls.push(request);
                    return fakeStream;
                },
            },
        },
    } as unknown as OpenAI;

    try {
        const service = new OpenAIService(fakeClient);
        const result = await service.generateStreamResponse(messages);

        assert.equal(result, fakeStream);
        assert.equal(calls.length, 1);
        assert.deepEqual(
            (calls[0] as { stream_options?: unknown }).stream_options,
            { include_usage: true }
        );
    } finally {
        restoreEnv("LANGFUSE_PUBLIC_KEY", previousPublicKey);
        restoreEnv("LANGFUSE_SECRET_KEY", previousSecretKey);
    }
});

test("RAG pipeline configuration rejects unregistered behavior versions", () => {
    const previous = process.env.RAG_PIPELINE_VERSION;
    process.env.RAG_PIPELINE_VERSION = "imaginary-rag-v9";
    try {
        assert.throws(getRagPipeline, /Unsupported RAG pipeline version/);
    } finally {
        if (previous === undefined) delete process.env.RAG_PIPELINE_VERSION;
        else process.env.RAG_PIPELINE_VERSION = previous;
    }
});

test("RAG pipeline configuration rejects inherited object properties", () => {
    const previous = process.env.RAG_PIPELINE_VERSION;
    try {
        for (const inheritedProperty of ["constructor", "toString"]) {
            process.env.RAG_PIPELINE_VERSION = inheritedProperty;
            assert.throws(
                getRagPipeline,
                new RegExp(
                    `Unsupported RAG pipeline version: ${inheritedProperty}`
                )
            );
        }
    } finally {
        restoreEnv("RAG_PIPELINE_VERSION", previous);
    }
});

test("normalizes chat usage and estimates versioned model cost", () => {
    const usage = normalizeModelUsage({
        prompt_tokens: 1_000,
        completion_tokens: 500,
        total_tokens: 1_500,
        prompt_tokens_details: { cached_tokens: 200 },
    });

    assert.deepEqual(usage, {
        inputTokens: 1_000,
        cachedInputTokens: 200,
        outputTokens: 500,
        totalTokens: 1_500,
    });
    assert.deepEqual(
        estimateModelCost("gpt-4o-mini", usage),
        {
            currency: "USD",
            amount: 0.000435,
            pricingVersion: "openai-standard-2026-07-16",
            sourceUrl:
                "https://developers.openai.com/api/docs/models/gpt-4o-mini",
        }
    );
    assert.equal(estimateModelCost("unknown-model", usage), null);
});
