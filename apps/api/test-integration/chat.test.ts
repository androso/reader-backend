import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, afterEach, before } from "node:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
    AppendBookChat,
    RunBookChat,
    StartBookChat,
} from "@reader/application";
import type {
    ChatAnswerGeneration,
    ChatContextRetrieval,
    ChatExecutionMetadataBuilder,
    ChatShadowScheduler,
    ChatTraceObservation,
    ChatTracing,
} from "@reader/application";
import type { ChatGenerationResult } from "@reader/domain";
import { ChatCancelledError } from "@reader/domain";
import { Pool } from "pg";
import { CHAT_OPERATIONS } from "../src/chat/chat-stream";
import { RATE_LIMIT_CLIENT } from "../src/common/rate-limit.module";
import {
    APPEND_BOOK_CHAT,
    START_BOOK_CHAT,
} from "../src/infrastructure/chat/chat.tokens";
import {
    createChatResourceAccess,
    createDrizzleChatConversationRepository,
    createDrizzleChatMessageRepository,
} from "../src/infrastructure/chat";
import { Books, Conversations, Messages, Users } from "../src/db/schema";
import { createTestApp } from "../test/helpers/nestApp";
import type { User } from "../src/types";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
let userId = "";
let app: Awaited<ReturnType<typeof createTestApp>>;
let bookId = "";
let currentQuery = "";
const scenarios = new Map<
    string,
    (options: {
        signal?: AbortSignal;
        onContent(chunk: string): void | Promise<void>;
    }) => Promise<ChatGenerationResult>
>();
let assistantPersistence:
    | {
          started: ReturnType<typeof deferred>;
          gate: ReturnType<typeof deferred>;
          signal?: AbortSignal;
      }
    | undefined;
const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const waitForAbort = (signal?: AbortSignal) => {
    if (!signal) throw new Error("Expected chat AbortSignal");
    if (signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("Timed out waiting for SSE disconnect"));
        }, 5_000);
        const onAbort = () => {
            clearTimeout(timeout);
            resolve();
        };
        signal.addEventListener("abort", onAbort, { once: true });
    });
};

const makeTrace = (): ChatTraceObservation => ({
    traceId: "integration-trace",
    setTraceIO: () => {},
    startObservation: () => makeTrace(),
    update: () => {},
    end: () => {},
});

const tracing: ChatTracing = {
    run: (_meta, callback) => callback(makeTrace()),
};
const retrieval: ChatContextRetrieval = {
    async retrieve(input) {
        return {
            status: "ready",
            messages: input.messages,
            sources: null,
            telemetry: {
                pipelineVersion: "integration",
                promptVersion: "integration",
                queryPlan: null,
                retrieval: null,
            },
        };
    },
};
const generation: ChatAnswerGeneration = {
    async generate(input, options) {
        currentQuery = input.messages.at(-1)?.content ?? "";
        const scenario = scenarios.get(currentQuery);
        if (scenario) return scenario(options);
        await options.onContent("integration answer");
        return {
            answer: "integration answer",
            modelVersion: input.model,
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    },
};
const metadata: ChatExecutionMetadataBuilder = {
    build: () => ({
        pipelineVersion: "integration",
        promptVersion: "integration",
        generation: { estimatedCost: 0 },
        totalLatencyMs: 1,
    }),
};
const shadow: ChatShadowScheduler = { maybeSchedule: async () => {} };

const captureResponse = async (response: Response) => {
    const text = await response.text();
    const frames = text
        .split("\n\n")
        .filter((frame) => frame.startsWith("data: "))
        .map((frame) => frame.slice(6))
        .filter((frame) => frame !== "[DONE]")
        .map((frame) => JSON.parse(frame) as Record<string, unknown>);
    return { text, frames };
};

const postChat = (
    message: string,
    signal?: AbortSignal,
    conversationId?: string
) =>
    fetch(
        conversationId
            ? `${app.baseUrl}/api/book/${bookId}/conversations/${conversationId}/messages`
            : `${app.baseUrl}/api/book/${bookId}/conversations`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Origin: "http://localhost:5173",
            },
            body: JSON.stringify({ message }),
            signal,
        }
    );

const createBook = async () => {
    const [book] = await db
        .insert(Books)
        .values({
            title: "chat-integration.pdf",
            userId,
            fileKey: `chat-${randomUUID()}`,
            fileType: "pdf",
            collectionName: "integration-collection",
            processingStatus: "ready",
        })
        .returning();
    bookId = book.id;
};

before(async () => {
    assert.ok(process.env.DATABASE_URL);
    userId = randomUUID();
    await db.insert(Users).values({
        id: userId,
        email: `${userId}@reader-it.invalid`,
        name: "Chat integration",
    });
    const user: User = {
        id: userId,
        email: `${userId}@reader-it.invalid`,
        name: "Chat integration",
        image: null,
        googleId: null,
        username: null,
        password: null,
        createdAt: new Date(),
        updatedAt: new Date(),
    };
    const conversations = createDrizzleChatConversationRepository(db as never);
    const storedMessages = createDrizzleChatMessageRepository(db as never);
    const messages = {
        ...storedMessages,
        async append(message: Parameters<typeof storedMessages.append>[0]) {
            if (
                message.role === "assistant" &&
                currentQuery === "disconnect during persistence" &&
                assistantPersistence
            ) {
                assistantPersistence.signal = message.signal;
                assistantPersistence.started.resolve();
                await assistantPersistence.gate.promise;
                if (message.signal?.aborted) throw new ChatCancelledError();
            }
            return storedMessages.append(message);
        },
    };
    const runner = new RunBookChat({
        retrieval,
        generation,
        messages,
        conversations,
        tracing,
        shadow,
        metadata,
        clock: { now: () => new Date() },
    });
    const access = createChatResourceAccess(db as never);
    const modelResolver = { resolve: () => "gpt-4o-mini" };
    const start = new StartBookChat({
        resourceAccess: access,
        conversations,
        messages,
        modelResolver,
        clock: { now: () => new Date() },
        runner,
    });
    const append = new AppendBookChat({
        resourceAccess: access,
        conversations,
        messages,
        modelResolver,
        clock: { now: () => new Date() },
        runner,
    });
    app = await createTestApp({
        fullStack: true,
        db: db as never,
        user,
        overrides: [
            { token: CHAT_OPERATIONS, useValue: {} },
            { token: START_BOOK_CHAT, useValue: start },
            { token: APPEND_BOOK_CHAT, useValue: append },
            {
                token: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
    });
});

afterEach(async () => {
    scenarios.clear();
    await db
        .delete(Conversations)
        .where(
            and(
                eq(Conversations.userId, userId),
                eq(Conversations.resourceId, bookId)
            )
        );
    if (bookId) {
        await db.delete(Books).where(eq(Books.id, bookId));
        bookId = "";
    }
});

after(async () => {
    await app?.close();
    await db.delete(Users).where(eq(Users.id, userId));
    await pool.end();
});

test("real HTTP chat creates, appends, lists, and retrieves scoped conversations", async () => {
    await createBook();
    const created = await postChat("first question");
    assert.equal(created.status, 200);
    const createdStream = await captureResponse(created);
    const conversationId = String(
        createdStream.frames.find((frame) => frame.type === "conversation_id")
            ?.conversationId
    );
    assert.ok(conversationId);
    assert.ok(
        createdStream.frames.some(
            (frame) => frame.content === "integration answer"
        )
    );

    const appended = await postChat("follow up", undefined, conversationId);
    assert.equal(appended.status, 200);
    await captureResponse(appended);
    const listed = await fetch(
        `${app.baseUrl}/api/book/${bookId}/conversations`
    );
    assert.equal(listed.status, 200);
    const listBody = (await listed.json()) as {
        conversations: Array<{ id: string }>;
    };
    assert.deepEqual(
        listBody.conversations.map((conversation) => conversation.id),
        [conversationId]
    );
    const detail = await fetch(
        `${app.baseUrl}/api/book/${bookId}/conversations/${conversationId}`
    );
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
        messages: Array<{ role: string; content: string }>;
    };
    assert.deepEqual(
        detailBody.messages.map(({ role, content }) => [role, content]),
        [
            ["user", "first question"],
            ["assistant", "integration answer"],
            ["user", "follow up"],
            ["assistant", "integration answer"],
        ]
    );
    assert.equal(
        JSON.stringify(detailBody).includes("executionMetadata"),
        false
    );
});

test("HTTP disconnect before first chunk, mid-generation, and during assistant persistence is cancellation-safe", async () => {
    await createBook();

    const beforeFirstStarted = deferred();
    const beforeFirstSettled = deferred();
    scenarios.set("disconnect before first", async (options) => {
        beforeFirstStarted.resolve();
        await waitForAbort(options.signal);
        try {
            await options.onContent("late before first");
        } finally {
            beforeFirstSettled.resolve();
        }
        return {
            answer: "late before first",
            modelVersion: "gpt-4o-mini",
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    });
    const beforeFirstAbort = new AbortController();
    const beforeFirstResponse = await postChat(
        "disconnect before first",
        beforeFirstAbort.signal
    );
    await beforeFirstStarted.promise;
    beforeFirstAbort.abort();
    await beforeFirstResponse.body?.cancel().catch(() => {});
    await beforeFirstSettled.promise;

    const midStarted = deferred();
    const midSettled = deferred();
    scenarios.set("disconnect mid generation", async (options) => {
        await options.onContent("first chunk");
        midStarted.resolve();
        await waitForAbort(options.signal);
        try {
            await options.onContent("late second chunk");
        } finally {
            midSettled.resolve();
        }
        return {
            answer: "first chunk",
            modelVersion: "gpt-4o-mini",
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    });
    const midAbort = new AbortController();
    const midResponse = await postChat(
        "disconnect mid generation",
        midAbort.signal
    );
    const reader = midResponse.body!.getReader();
    await reader.read();
    await midStarted.promise;
    midAbort.abort();
    await reader.cancel().catch(() => {});
    await midSettled.promise;

    const persistStarted = deferred();
    const persistGate = deferred();
    assistantPersistence = { started: persistStarted, gate: persistGate };
    scenarios.set("disconnect during persistence", async (options) => {
        await options.onContent("ready for persistence");
        return {
            answer: "ready for persistence",
            modelVersion: "gpt-4o-mini",
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    });
    const persistAbort = new AbortController();
    const persistResponse = await postChat(
        "disconnect during persistence",
        persistAbort.signal
    );
    await persistStarted.promise;
    persistAbort.abort();
    await persistResponse.body?.cancel().catch(() => {});
    await waitForAbort(assistantPersistence.signal);
    persistGate.resolve();
    assistantPersistence = undefined;

    const rows = await db
        .select({ role: Messages.role, content: Messages.content })
        .from(Messages)
        .innerJoin(Conversations, eq(Messages.conversationId, Conversations.id))
        .where(
            and(
                eq(Conversations.userId, userId),
                eq(Conversations.resourceId, bookId)
            )
        );
    assert.equal(rows.filter((row) => row.role === "assistant").length, 0);
    assert.equal(rows.filter((row) => row.role === "user").length, 3);
});

test("real HTTP streaming tolerates a slow reader and late provider completion without unhandled rejections", async () => {
    await createBook();
    scenarios.set("slow reader", async (options) => {
        const chunk = "x".repeat(8_192);
        for (let index = 0; index < 16; index += 1) {
            await options.onContent(chunk);
        }
        return {
            answer: chunk.repeat(16),
            modelVersion: "gpt-4o-mini",
            finishReason: "stop",
            streamCompleted: true,
            usage: null,
            durationMs: 1,
        };
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
        const controller = new AbortController();
        const slow = postChat("slow reader", controller.signal);
        const response = await slow;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const result = await captureResponse(response);
        assert.equal(
            result.frames.filter((frame) => typeof frame.content === "string")
                .length,
            16
        );

        const started = deferred();
        const lateSettled = deferred();
        scenarios.set("late provider completion", async (options) => {
            started.resolve();
            await waitForAbort(options.signal);
            try {
                await options.onContent("provider completed after close");
            } finally {
                lateSettled.resolve();
            }
            return {
                answer: "late",
                modelVersion: "gpt-4o-mini",
                finishReason: "stop",
                streamCompleted: true,
                usage: null,
                durationMs: 1,
            };
        });
        const abort = new AbortController();
        const request = postChat("late provider completion", abort.signal);
        await started.promise;
        abort.abort();
        await request.catch(() => undefined);
        await lateSettled.promise;
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, []);
    } finally {
        process.removeListener("unhandledRejection", onUnhandled);
    }
});
