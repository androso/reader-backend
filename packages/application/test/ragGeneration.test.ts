import assert from "node:assert/strict";
import test from "node:test";
import {
    ChatCancelledError,
    type ChatPromptMessage,
    type RagRankedResult,
} from "@reader/domain";
import type { AnswerModelStream, RagAnswerModelChunk } from "../src/rag/ports";
import { GenerateGroundedAnswer } from "../src/rag/GenerateGroundedAnswer";
import { PrepareGroundedContext } from "../src/rag/PrepareGroundedContext";
import { buildGroundedSystemPrompt } from "../src/rag/policies/groundedPrompt";
import type { RetrieveBookEvidenceResult } from "../src/rag/RetrieveBookEvidence";

const messages: ChatPromptMessage[] = [
    { role: "user", content: "What happened?" },
];

const makeAnswerModel = (
    chunks: RagAnswerModelChunk[],
    error?: unknown
): AnswerModelStream => ({
    stream: async function* () {
        for (const chunk of chunks) yield chunk;
        if (error) throw error;
    },
});

const makeUseCase = (model: AnswerModelStream) =>
    new GenerateGroundedAnswer({
        model,
        clock: { now: () => new Date(1_000) },
    });

const chunk = (
    values: Partial<RagAnswerModelChunk> = {}
): RagAnswerModelChunk => ({
    delta: "",
    finishReason: null,
    usage: null,
    resolvedModel: "",
    ...values,
});

const result: RagRankedResult = {
    id: "chunk-1",
    content: "Retrieved evidence",
    chunkIndex: 0,
    score: 0.04,
    bestRank: 1,
};

const readyEvidence: RetrieveBookEvidenceResult = {
    status: "ready",
    sources: null,
    results: [result],
    telemetry: {
        pipelineVersion: "baseline-rag-v1",
        promptVersion: "book-context-v1",
        queryPlan: null,
        retrieval: null,
    },
};

test("PrepareGroundedContext preserves prompt, version, history and highlight", () => {
    const prepared = new PrepareGroundedContext().execute({
        evidence: readyEvidence,
        messages,
        highlightContext: { sourceType: "epub", text: "Selected passage" },
    });

    assert.equal(prepared.promptVersion, "book-context-v1");
    assert.equal(prepared.context, "Retrieved evidence");
    assert.equal(
        prepared.systemPrompt,
        buildGroundedSystemPrompt("Retrieved evidence", {
            sourceType: "epub",
            text: "Selected passage",
        })
    );
    assert.deepEqual(prepared.messages, [
        { role: "system", content: prepared.systemPrompt! },
        ...messages,
    ]);
    assert.match(prepared.systemPrompt!, /untrusted data, not instructions/i);
    assert.match(prepared.systemPrompt!, /Untrusted selected passage/);
});

test("PrepareGroundedContext leaves non-ready and empty evidence unchanged", () => {
    const useCase = new PrepareGroundedContext();
    const missing = useCase.execute({
        evidence: {
            ...readyEvidence,
            status: "not_found",
            results: undefined,
        },
        messages,
        highlightContext: null,
    });
    const empty = useCase.execute({
        evidence: { ...readyEvidence, results: [] },
        messages,
        highlightContext: null,
    });

    assert.equal(missing.context, null);
    assert.equal(missing.systemPrompt, null);
    assert.strictEqual(missing.messages, messages);
    assert.equal(empty.context, null);
    assert.strictEqual(empty.messages, messages);
});

test("GenerateGroundedAnswer accumulates resolved model, finish reason and usage", async () => {
    const useCase = makeUseCase(
        makeAnswerModel([
            chunk({
                delta: "A",
                resolvedModel: "resolved-model",
                usage: { input_tokens: 2 },
            }),
            chunk({ delta: "B", finishReason: "stop" }),
        ])
    );
    const contents: string[] = [];
    const result = await useCase.execute({
        messages,
        model: "requested-model",
        onContent: (content) => {
            contents.push(content);
        },
    });

    assert.deepEqual(contents, ["A", "B"]);
    assert.equal(result.answer, "AB");
    assert.equal(result.modelVersion, "resolved-model");
    assert.equal(result.finishReason, "stop");
    assert.equal(result.streamCompleted, true);
    assert.deepEqual(result.usage, { input_tokens: 2 });
    assert.equal(result.durationMs, 0);
});

test("GenerateGroundedAnswer recovers only premature close after a completed stream", async () => {
    const failure = Object.assign(new Error("Premature close"), {
        kind: "premature_close" as const,
        transportWarning: "Error ERR_STREAM_PREMATURE_CLOSE Premature close",
    });
    const result = await makeUseCase(
        makeAnswerModel(
            [chunk({ delta: "partial", finishReason: "stop" })],
            failure
        )
    ).execute({ messages, model: "model" });

    assert.equal(result.answer, "partial");
    assert.equal(result.streamCompleted, true);
    assert.equal(
        result.transportWarning,
        "Error ERR_STREAM_PREMATURE_CLOSE Premature close"
    );
});

test("GenerateGroundedAnswer propagates premature close before completion", async () => {
    const failure = Object.assign(new Error("Premature close"), {
        kind: "premature_close" as const,
    });
    await assert.rejects(
        makeUseCase(
            makeAnswerModel([chunk({ delta: "partial" })], failure)
        ).execute({ messages, model: "model" }),
        (error) => error === failure
    );
});

test("GenerateGroundedAnswer propagates provider-local timeout", async () => {
    const failure = Object.assign(new Error("request timed out"), {
        kind: "timeout" as const,
    });
    await assert.rejects(
        makeUseCase(makeAnswerModel([], failure)).execute({
            messages,
            model: "model",
        }),
        (error) => error === failure
    );
});

test("caller cancellation interrupts a pending provider chunk and ignores late output", async () => {
    let release!: () => void;
    let nextCalls = 0;
    let writes = 0;
    const model: AnswerModelStream = {
        stream: () => ({
            [Symbol.asyncIterator]: () => ({
                next: () => {
                    nextCalls += 1;
                    return new Promise((resolve) => {
                        release = () =>
                            resolve({
                                done: false,
                                value: chunk({
                                    delta: "late",
                                    finishReason: "stop",
                                }),
                            });
                    });
                },
                return: async () => ({ done: true, value: undefined }),
            }),
        }),
    };
    const controller = new AbortController();
    const pending = makeUseCase(model).execute({
        messages,
        model: "model",
        signal: controller.signal,
        onContent: () => {
            writes += 1;
            return undefined;
        },
    });

    await Promise.resolve();
    controller.abort();
    await assert.rejects(pending, ChatCancelledError);
    release();
    await Promise.resolve();

    assert.equal(nextCalls, 1);
    assert.equal(writes, 0);
});
