import assert from "node:assert/strict";
import test from "node:test";
import {
    OpenAIChatReranker,
    RERANKER_DEVELOPER_INSTRUCTION,
    RERANKER_MAX_COMPLETION_TOKENS,
    RERANKER_MODEL,
    RERANKER_TIMEOUT_MS,
    buildRerankerRequest,
    parseRerankerResponse,
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
    assert.equal(
        request.response_format.json_schema.schema.properties.rankings.minItems,
        2
    );
    assert.equal(
        request.response_format.json_schema.schema.properties.rankings.maxItems,
        2
    );
    assert.equal("temperature" in request, false);
    assert.equal("top_p" in request, false);
});

test("makes one request and returns validated rankings", async () => {
    const calls: Array<{ request: unknown; options: unknown }> = [];
    const client = {
        chat: {
            completions: {
                create: async (request: unknown, options: unknown) => {
                    calls.push({ request, options });
                    return {
                        model: RERANKER_MODEL,
                        choices: [
                            {
                                message: {
                                    content: JSON.stringify({
                                        rankings: [
                                            { id: "chunk-1", score: 0.9 },
                                            { id: "chunk-2", score: 0.2 },
                                        ],
                                    }),
                                },
                            },
                        ],
                        usage: { prompt_tokens: 10, completion_tokens: 5 },
                    };
                },
            },
        },
    } as unknown as Pick<OpenAI, "chat">;
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
    assert.ok(
        (calls[0].options as { signal: AbortSignal }).signal instanceof
            AbortSignal
    );
    assert.equal(RERANKER_TIMEOUT_MS, 10_000);
});

test("rejects invalid JSON, duplicate IDs, and missing IDs", () => {
    assert.throws(
        () => parseRerankerResponse("not json", candidates),
        /invalid JSON/
    );
    assert.throws(
        () => parseRerankerResponse('{"rankings":[]}', candidates),
        /wrong number/
    );
    assert.throws(
        () =>
            parseRerankerResponse(
                '{"rankings":[{"id":"chunk-1","score":2},{"id":"chunk-2","score":0}]}',
                candidates
            ),
        /out-of-range score/
    );
    assert.throws(
        () =>
            parseRerankerResponse(
                '{"rankings":[{"id":"chunk-1","score":1},{"id":"chunk-1","score":0}]}',
                candidates
            ),
        /duplicate ID/
    );
    assert.throws(
        () =>
            parseRerankerResponse(
                '{"rankings":[{"id":"chunk-1","score":1},{"id":"missing","score":0}]}',
                candidates
            ),
        /unknown ID/
    );
});

test("validates topN and provider document bounds", async () => {
    const unusedClient = {
        chat: {
            completions: { create: async () => assert.fail("unexpected call") },
        },
    } as unknown as Pick<OpenAI, "chat">;
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
        chat: {
            completions: {
                create: async (
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
    } as unknown as Pick<OpenAI, "chat">;
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

test("propagates refusal and timeout/provider rejection without retry", async () => {
    const refusingClient = {
        chat: {
            completions: {
                create: async () => ({
                    model: RERANKER_MODEL,
                    choices: [{ message: { content: null, refusal: "no" } }],
                }),
            },
        },
    } as unknown as Pick<OpenAI, "chat">;
    await assert.rejects(
        new OpenAIChatReranker(refusingClient).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        /refused/
    );
    let calls = 0;
    const timeoutClient = {
        chat: {
            completions: {
                create: async () => {
                    calls += 1;
                    throw new Error("request timed out");
                },
            },
        },
    } as unknown as Pick<OpenAI, "chat">;
    await assert.rejects(
        new OpenAIChatReranker(timeoutClient).rerank({
            query: "query",
            documents: candidates,
            topN: 2,
        }),
        /timed out/
    );
    assert.equal(calls, 1);
});
