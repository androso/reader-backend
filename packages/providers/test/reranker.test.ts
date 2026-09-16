import assert from "node:assert/strict";
import test from "node:test";
import {
    OpenAIChatReranker,
    RERANKER_DEVELOPER_INSTRUCTION,
    RERANKER_MAX_COMPLETION_TOKENS,
    RERANKER_MODEL,
    RERANKER_TIMEOUT_MS,
    buildRerankerRequest,
} from "../src/reranker";
import type OpenAI from "openai";

const candidates = [
    { id: "chunk-1", content: "The rabbit ran past Alice." },
    { id: "chunk-2", content: "Tea was served at the table." },
];

test("builds the pinned deterministic strict-schema request", () => {
    const request = buildRerankerRequest("Who ran past Alice?", candidates, 2);
    assert.equal(request.model, RERANKER_MODEL);
    assert.equal(request.messages[0].role, "developer");
    assert.equal(request.messages[0].content, RERANKER_DEVELOPER_INSTRUCTION);
    assert.equal(request.reasoning_effort, "none");
    assert.equal(request.max_completion_tokens, RERANKER_MAX_COMPLETION_TOKENS);
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.response_format.json_schema.strict, true);
    assert.deepEqual(
        request.response_format.$parseRaw(
            JSON.stringify({
                rankings: [
                    { alias: "d0", score: 0.9 },
                    { alias: "d1", score: 0.2 },
                ],
            })
        ),
        {
            rankings: [
                { alias: "d0", score: 0.9 },
                { alias: "d1", score: 0.2 },
            ],
        }
    );
    assert.throws(() => request.response_format.$parseRaw("not json"));
    assert.throws(() =>
        request.response_format.$parseRaw(JSON.stringify({ rankings: [] }))
    );
    assert.throws(() =>
        request.response_format.$parseRaw(
            JSON.stringify({
                rankings: [
                    { alias: "d0", score: 1 },
                    { alias: "missing", score: 0 },
                ],
            })
        )
    );
    assert.throws(() =>
        request.response_format.$parseRaw(
            JSON.stringify({
                rankings: [
                    { alias: "d0", score: 2 },
                    { alias: "d1", score: 0 },
                ],
            })
        )
    );
    const payload = JSON.parse(request.messages[1].content);
    assert.deepEqual(payload.documents, [
        { alias: "d0", text: candidates[0].content },
        { alias: "d1", text: candidates[1].content },
    ]);
    assert.equal(request.messages[1].content.includes("chunk-1"), false);
    assert.equal(request.messages[1].content.includes("chunk-2"), false);
    assert.equal("temperature" in request, false);
    assert.equal("top_p" in request, false);
});

test("makes one request and returns validated rankings", async () => {
    const calls: Array<{ request: unknown; options: unknown }> = [];
    const client = {
        beta: {
            chat: {
                completions: {
                    parse: async (request: unknown, options: unknown) => {
                        calls.push({ request, options });
                        return {
                            model: RERANKER_MODEL,
                            choices: [
                                {
                                    message: {
                                        parsed: {
                                            rankings: [
                                                { alias: "d0", score: 0.9 },
                                                { alias: "d1", score: 0.2 },
                                            ],
                                        },
                                        refusal: null,
                                    },
                                },
                            ],
                            usage: { prompt_tokens: 10, completion_tokens: 5 },
                        };
                    },
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    const result = await new OpenAIChatReranker(client).rerank({
        query: "Who ran?",
        documents: candidates,
        topN: candidates.length,
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.rankings, [
        { id: "chunk-1", score: 0.9, rank: 1 },
        { id: "chunk-2", score: 0.2, rank: 2 },
    ]);
    assert.equal(result.requestedModel, RERANKER_MODEL);
    assert.equal(result.resolvedModel, RERANKER_MODEL);
    const callOptions = calls[0].options;
    assert.ok(
        callOptions &&
            typeof callOptions === "object" &&
            "signal" in callOptions &&
            callOptions.signal instanceof AbortSignal
    );
    assert.equal(RERANKER_TIMEOUT_MS, 10_000);
});

test("rejects duplicate aliases from an injected parsed response", async () => {
    const client = {
        beta: {
            chat: {
                completions: {
                    parse: async () => ({
                        choices: [
                            {
                                message: {
                                    parsed: {
                                        rankings: [
                                            { alias: "d0", score: 1 },
                                            { alias: "d0", score: 0 },
                                        ],
                                    },
                                    refusal: null,
                                },
                            },
                        ],
                    }),
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    await assert.rejects(
        new OpenAIChatReranker(client).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        /duplicate alias/
    );
});

test("validates topN and provider document bounds", async () => {
    const unusedClient = {
        beta: {
            chat: {
                completions: {
                    parse: async () => assert.fail("unexpected call"),
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    const reranker = new OpenAIChatReranker(unusedClient);
    for (const topN of [0, 3, 1.5]) {
        await assert.rejects(
            reranker.rerank({ query: "query", documents: candidates, topN }),
            /topN/
        );
    }
    await assert.rejects(
        reranker.rerank({
            query: "query",
            topN: 1,
            documents: Array.from({ length: 31 }, (_, index) => ({
                id: String(index),
                content: "x",
            })),
        }),
        /1-30/
    );
    await assert.rejects(
        reranker.rerank({
            query: "query",
            topN: 1,
            documents: [{ id: "huge", content: "x".repeat(40_001) }],
        }),
        /40000/
    );
});

test("preserves caller aborts while applying the timeout", async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = {
        beta: {
            chat: {
                completions: {
                    parse: async (
                        _request: unknown,
                        options: { signal?: AbortSignal }
                    ) => {
                        receivedSignal = options.signal;
                        if (options.signal?.aborted) {
                            throw options.signal.reason;
                        }
                        throw new Error("expected abort");
                    },
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    const controller = new AbortController();
    controller.abort(new Error("caller aborted"));
    await assert.rejects(
        new OpenAIChatReranker(client).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
            signal: controller.signal,
        }),
        /caller aborted/
    );
    assert.equal(receivedSignal?.aborted, true);
});

test("propagates refusal, missing parsed output, and provider rejection", async () => {
    let refusalCalls = 0;
    const refusingClient = {
        beta: {
            chat: {
                completions: {
                    parse: async () => {
                        refusalCalls += 1;
                        return {
                            model: RERANKER_MODEL,
                            choices: [
                                {
                                    message: {
                                        parsed: null,
                                        refusal: "no",
                                    },
                                },
                            ],
                        };
                    },
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    await assert.rejects(
        new OpenAIChatReranker(refusingClient).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        { message: "Reranker refused the request" }
    );
    assert.equal(refusalCalls, 1);

    let missingCalls = 0;
    const missingClient = {
        beta: {
            chat: {
                completions: {
                    parse: async () => {
                        missingCalls += 1;
                        return {
                            model: RERANKER_MODEL,
                            choices: [
                                {
                                    message: {
                                        parsed: null,
                                        refusal: null,
                                    },
                                },
                            ],
                        };
                    },
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    await assert.rejects(
        new OpenAIChatReranker(missingClient).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        { message: "Reranker returned no structured content" }
    );
    assert.equal(missingCalls, 1);

    let providerCalls = 0;
    const providerError = new Error("request timed out");
    const timeoutClient = {
        beta: {
            chat: {
                completions: {
                    parse: async () => {
                        providerCalls += 1;
                        throw providerError;
                    },
                },
            },
        },
    } as unknown as Pick<OpenAI, "beta">;
    await assert.rejects(
        new OpenAIChatReranker(timeoutClient).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        providerError
    );
    assert.equal(providerCalls, 1);
});
