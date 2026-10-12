import assert from "node:assert/strict";
import test from "node:test";
import {
    ChatCancelledError,
    ChatValidationError,
    type ChatGenerationResult,
    type ChatPromptMessage,
    type ChatRetrievalDiagnostics,
} from "@reader/domain";
import {
    AppendBookChat,
    RunBookChat,
    StartBookChat,
    type RunBookChatDependencies,
} from "../src";
import type { ChatEventSink } from "../src";

const diagnostics: ChatRetrievalDiagnostics = {
    pipelineVersion: "v1",
    promptVersion: "v1",
    queryPlan: null,
    retrieval: null,
};

const generated: ChatGenerationResult = {
    answer: "answer",
    modelVersion: "gpt-4o-mini",
    finishReason: "stop",
    streamCompleted: true,
    usage: { input_tokens: 2, output_tokens: 1 },
    durationMs: 12,
};

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const makeSink = (calls: unknown[]): ChatEventSink => ({
    async emit(event) {
        calls.push(["emit", event]);
    },
    async complete() {
        calls.push(["complete"]);
    },
});

const makeRunner = (
    calls: unknown[],
    overrides: Partial<RunBookChatDependencies> = {}
) =>
    new RunBookChat({
        retrieval: {
            async retrieve(input, signal) {
                calls.push(["retrieve", input.query, signal]);
                return {
                    status: "ready",
                    messages: input.messages,
                    sources: null,
                    telemetry: diagnostics,
                };
            },
        },
        generation: {
            async generate(_input, options) {
                calls.push(["generate"]);
                await options.onContent("token");
                return generated;
            },
        },
        messages: {
            async append(message) {
                calls.push(["append-assistant", message]);
                return {
                    id: "assistant-1",
                    conversationId: message.conversationId,
                    role: "assistant",
                    content: message.content,
                    contextSources: null,
                    completionStatus: "complete",
                    finishReason: "stop",
                    createdAt: new Date(0),
                };
            },
        },
        conversations: {
            async touch(id) {
                calls.push(["touch", id]);
            },
        },
        tracing: {
            async run(_meta, fn) {
                calls.push(["trace"]);
                return fn({
                    traceId: "trace-1",
                    setTraceIO: () => calls.push(["trace-output"]),
                    startObservation: () => ({
                        traceId: "trace-1",
                        setTraceIO: () => undefined,
                        startObservation: () => {
                            throw new Error("unexpected nested observation");
                        },
                        update: () => undefined,
                        end: () => undefined,
                    }),
                    update: () => undefined,
                    end: () => undefined,
                });
            },
        },
        shadow: {
            async maybeSchedule() {
                calls.push(["shadow"]);
            },
        },
        metadata: {
            build() {
                return {
                    pipelineVersion: "v1",
                    promptVersion: "v1",
                    generation: { estimatedCost: 0 },
                    totalLatencyMs: 10,
                };
            },
        },
        clock: { now: () => new Date(0) },
        ...overrides,
    });

const runInput = (calls: unknown[], signal = new AbortController().signal) => ({
    userId: "user-1",
    bookId: "book-1",
    conversationId: "conversation-1",
    userMessageId: "user-message-1",
    query: "question",
    messages: [{ role: "user", content: "question" }] as ChatPromptMessage[],
    model: "gpt-4o-mini",
    highlightContext: null,
    routeName: "append_message",
    sink: makeSink(calls),
    signal,
});

test("RunBookChat preserves retrieval, generation, persistence, completion, and shadow order", async () => {
    const calls: unknown[] = [];
    await makeRunner(calls).execute(runInput(calls));

    assert.deepEqual(
        calls.map((call) => (call as unknown[])[0]),
        [
            "trace",
            "retrieve",
            "generate",
            "emit",
            "append-assistant",
            "touch",
            "trace-output",
            "emit",
            "complete",
            "shadow",
        ]
    );
    assert.deepEqual(calls[3], ["emit", { content: "token" }]);
    assert.deepEqual(calls[8], ["complete"]);
});

test("RunBookChat completes retrieval status responses without generation or persistence", async () => {
    const calls: unknown[] = [];
    const runner = makeRunner(calls, {
        retrieval: {
            async retrieve() {
                return {
                    status: "processing",
                    messages: [],
                    sources: null,
                    telemetry: diagnostics,
                };
            },
        },
    });

    await runner.execute(runInput(calls));
    assert.deepEqual(
        calls.map((call) => (call as unknown[])[0]),
        ["trace", "trace-output", "emit", "complete"]
    );
    assert.deepEqual(calls[2], [
        "emit",
        {
            error: "Document context is still processing. Please try again shortly.",
            status: "processing",
        },
    ]);
});

test("RunBookChat does not persist or schedule shadow work when cancellation happens before the first chunk", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const runner = makeRunner(calls, {
        generation: {
            async generate(_input, options) {
                controller.abort();
                await options.onContent("late");
                return generated;
            },
        },
    });

    await assert.rejects(
        runner.execute(runInput(calls, controller.signal)),
        ChatCancelledError
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "emit"),
        false
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "append-assistant"),
        false
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "shadow"),
        false
    );
});

test("RunBookChat ignores late provider content after cancellation and never starts persistence", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const provider = deferred<void>();
    let onContent: ((chunk: string) => void | Promise<void>) | undefined;
    const runner = makeRunner(calls, {
        generation: {
            async generate(_input, options) {
                onContent = options.onContent;
                await provider.promise;
                await options.onContent("late completion");
                return generated;
            },
        },
    });

    const result = runner.execute(runInput(calls, controller.signal));
    while (!onContent) await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    provider.resolve();
    await assert.rejects(result, ChatCancelledError);
    await assert.rejects(
        Promise.resolve().then(() => onContent!("after termination")),
        ChatCancelledError
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "append-assistant"),
        false
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "shadow"),
        false
    );
});

test("RunBookChat checks cancellation after generation and before persistence", async () => {
    const calls: unknown[] = [];
    const controller = new AbortController();
    const runner = makeRunner(calls, {
        generation: {
            async generate() {
                controller.abort();
                return generated;
            },
        },
    });

    await assert.rejects(
        runner.execute(runInput(calls, controller.signal)),
        ChatCancelledError
    );
    assert.equal(
        calls.some((call) => (call as unknown[])[0] === "append-assistant"),
        false
    );
});

test("StartBookChat keeps validation and persistence order", async () => {
    const calls: unknown[] = [];
    const runner = makeRunner(calls, {
        retrieval: {
            async retrieve(input) {
                calls.push(["retrieve", input.messages]);
                return {
                    status: "processing",
                    messages: [],
                    sources: null,
                    telemetry: diagnostics,
                };
            },
        },
    });
    const start = new StartBookChat({
        resourceAccess: {
            async authorize(input) {
                calls.push(["authorize", input]);
                return { resourceType: "book" };
            },
        },
        conversations: {
            async create(input) {
                calls.push(["create", input]);
                return { id: "conversation-1" };
            },
            async touch(id) {
                calls.push(["touch-user", id]);
            },
        },
        messages: {
            async append(message) {
                calls.push(["append-user", message]);
                return {
                    id: "user-message-1",
                    conversationId: message.conversationId,
                    role: "user",
                    content: message.content,
                    contextSources: null,
                    completionStatus: null,
                    finishReason: null,
                    createdAt: new Date(0),
                };
            },
        },
        modelResolver: { resolve: () => "gpt-4o-mini" },
        clock: { now: () => new Date(0) },
        runner,
    });

    const controller = new AbortController();
    await start.execute({
        userId: "user-1",
        resourceType: "book",
        resourceId: "book-1",
        message: "  hello  ",
        model: undefined,
        highlightContext: null,
        sink: makeSink(calls),
        signal: controller.signal,
    });
    assert.deepEqual(
        calls.map((call) => (call as unknown[])[0]),
        [
            "authorize",
            "create",
            "emit",
            "append-user",
            "touch-user",
            "trace",
            "retrieve",
            "trace-output",
            "emit",
            "complete",
        ]
    );
    assert.deepEqual(calls[1], [
        "create",
        {
            userId: "user-1",
            title: "hello...",
            resourceType: "book",
            resourceId: "book-1",
        },
    ]);
    assert.deepEqual(calls[3], [
        "append-user",
        {
            conversationId: "conversation-1",
            role: "user",
            content: "hello",
            signal: controller.signal,
        },
    ]);
});

test("StartBookChat validates the message before model resolution or authorization", async () => {
    const calls: string[] = [];
    const start = new StartBookChat({
        resourceAccess: {
            async authorize() {
                calls.push("authorize");
                throw new Error("authorization should not run");
            },
        },
        conversations: {
            async create() {
                throw new Error("conversation should not be created");
            },
            async touch() {},
        },
        messages: {
            async append() {
                throw new Error("message should not be appended");
            },
        },
        modelResolver: {
            resolve() {
                calls.push("model");
                return null;
            },
        },
        clock: { now: () => new Date(0) },
        runner: makeRunner([]),
    });

    await assert.rejects(
        start.prepare({
            userId: "user-1",
            resourceType: "book",
            resourceId: "book-1",
            message: " ",
            model: "unsupported",
            highlightContext: null,
        }),
        (error: unknown) =>
            error instanceof ChatValidationError &&
            error.message === "Message is required"
    );
    assert.deepEqual(calls, []);
});

test("AppendBookChat reads history and persists the user message before running retrieval", async () => {
    const calls: unknown[] = [];
    const runner = makeRunner(calls, {
        retrieval: {
            async retrieve(input) {
                calls.push(["retrieve", input.messages]);
                return {
                    status: "processing",
                    messages: [],
                    sources: null,
                    telemetry: diagnostics,
                };
            },
        },
    });
    const append = new AppendBookChat({
        resourceAccess: {
            async authorize(input) {
                calls.push(["authorize", input]);
                return { resourceType: "book" };
            },
        },
        conversations: {
            async findScoped(input) {
                calls.push(["find", input]);
                return {
                    id: input.conversationId,
                    userId: input.userId,
                    title: "title",
                    createdAt: new Date(0),
                    lastMessageAt: new Date(0),
                    resourceType: "book",
                    resourceId: input.resourceId,
                };
            },
            async touch(id) {
                calls.push(["touch-user", id]);
            },
        },
        messages: {
            async listForConversation() {
                throw new Error("history projection should be used");
            },
            async listHistoryForConversation() {
                calls.push(["history"]);
                return [{ role: "assistant", content: "prior" }];
            },
            async append(message) {
                calls.push(["append-user", message]);
                return {
                    id: "user-message-1",
                    conversationId: message.conversationId,
                    role: "user",
                    content: message.content,
                    contextSources: null,
                    completionStatus: null,
                    finishReason: null,
                    createdAt: new Date(0),
                };
            },
        },
        modelResolver: { resolve: () => "gpt-4o-mini" },
        clock: { now: () => new Date(0) },
        runner,
    });

    await append.execute({
        userId: "user-1",
        resourceType: "book",
        resourceId: "book-1",
        conversationId: "conversation-1",
        message: " follow up ",
        model: undefined,
        highlightContext: null,
        sink: makeSink(calls),
        signal: new AbortController().signal,
    });
    assert.deepEqual(
        calls.map((call) => (call as unknown[])[0]),
        [
            "authorize",
            "find",
            "history",
            "append-user",
            "touch-user",
            "trace",
            "retrieve",
            "trace-output",
            "emit",
            "complete",
        ]
    );
    assert.deepEqual((calls[6] as unknown[])[1], [
        { role: "assistant", content: "prior" },
        { role: "user", content: "follow up" },
    ]);
});

test("AppendBookChat rejects an unsupported resource before validating the message", async () => {
    const append = new AppendBookChat({
        resourceAccess: {
            async authorize() {
                throw new Error("authorization should not run");
            },
        },
        conversations: {
            async findScoped() {
                throw new Error("conversation lookup should not run");
            },
            async touch() {},
        },
        messages: {
            async listForConversation() {
                return [];
            },
            async append() {
                throw new Error("message should not be appended");
            },
        },
        modelResolver: { resolve: () => null },
        clock: { now: () => new Date(0) },
        runner: makeRunner([]),
    });

    await assert.rejects(
        append.prepare({
            userId: "user-1",
            resourceType: "article",
            resourceId: "book-1",
            conversationId: "conversation-1",
            message: "",
            model: "unsupported",
            highlightContext: null,
        }),
        (error: unknown) =>
            error instanceof ChatValidationError &&
            error.message === "Invalid request"
    );
});
