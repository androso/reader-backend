import assert from "node:assert/strict";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import test from "node:test";

process.env.JWT_SECRET ??= "reader-api-test-secret";

const sseModule =
    require("../src/infrastructure/chat/sseChatSession") as typeof import("../src/infrastructure/chat/sseChatSession");
let onSessionDisposed = () => {};
const createSseChatSession = sseModule.createSseChatSession;
(
    sseModule as unknown as {
        createSseChatSession: typeof createSseChatSession;
    }
).createSseChatSession = (req, res) => {
    const session = createSseChatSession(req, res);
    const dispose = session.dispose.bind(session);
    session.dispose = () => {
        try {
            dispose();
        } finally {
            onSessionDisposed();
        }
    };
    return session;
};

const { AppendBookChat, StartBookChat } =
    require("@reader/application") as typeof import("@reader/application");
const { ChatController } =
    require("../src/chat/chat.controller") as typeof import("../src/chat/chat.controller");
const {
    APPEND_BOOK_CHAT,
    GET_BOOK_CONVERSATION,
    LIST_BOOK_CONVERSATIONS,
    START_BOOK_CHAT,
} =
    require("../src/infrastructure/chat/chat.tokens") as typeof import("../src/infrastructure/chat/chat.tokens");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const withTimeout = async <T>(
    promise: Promise<T>,
    label: string
): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`Timed out waiting for ${label}`)),
                    1_000
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

type RequestObservation = {
    req: IncomingMessage;
    res: ServerResponse;
    baseline: {
        aborted: number;
        close: number;
        drain: number;
    };
    writeCount: number;
    endCount: number;
};

const observeRequest = (
    server: http.Server,
    targetPath: string
): {
    records: RequestObservation[];
    dispose(): void;
} => {
    const records: RequestObservation[] = [];
    const onRequest = (req: IncomingMessage, res: ServerResponse) => {
        if (req.url !== targetPath) return;
        const record: RequestObservation = {
            req,
            res,
            baseline: {
                aborted: req.listenerCount("aborted"),
                close: res.listenerCount("close"),
                drain: res.listenerCount("drain"),
            },
            writeCount: 0,
            endCount: 0,
        };
        records.push(record);
        const originalWrite = res.write.bind(res);
        res.write = ((...args: Parameters<ServerResponse["write"]>) => {
            record.writeCount += 1;
            return originalWrite(...args);
        }) as ServerResponse["write"];
        const originalEnd = res.end.bind(res);
        res.end = ((...args: Parameters<ServerResponse["end"]>) => {
            record.endCount += 1;
            return originalEnd(...args);
        }) as ServerResponse["end"];
    };
    server.prependListener("request", onRequest);
    return {
        records,
        dispose: () => server.removeListener("request", onRequest),
    };
};

const waitForListenerCleanup = async (record: RequestObservation) => {
    const deadline = Date.now() + 1_000;
    while (
        record.req.listenerCount("aborted") !== record.baseline.aborted ||
        record.res.listenerCount("close") !== record.baseline.close ||
        record.res.listenerCount("drain") !== record.baseline.drain
    ) {
        if (Date.now() >= deadline) {
            throw new Error(
                `SSE listeners did not return to baseline (aborted ${record.req.listenerCount("aborted")}/${record.baseline.aborted}, close ${record.res.listenerCount("close")}/${record.baseline.close}, drain ${record.res.listenerCount("drain")}/${record.baseline.drain})`
            );
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};

const createAuthorizationBarrier = () => {
    const started = deferred();
    const gate = deferred();
    return {
        started,
        release: gate.resolve,
        authorize: async () => {
            started.resolve();
            await gate.promise;
        },
    };
};

const createPreparedApp = (
    barrier: ReturnType<typeof createAuthorizationBarrier>
) => {
    const state = {
        conversationCreates: 0,
        scopedLookups: 0,
        userMessageAppends: 0,
        executions: 0,
        preparationFinished: deferred(),
    };
    const resourceAccess = {
        async authorize() {
            await barrier.authorize();
            return { resourceType: "book" as const };
        },
    };
    const conversations = {
        async create() {
            state.conversationCreates += 1;
            state.preparationFinished.resolve();
            return { id: "conversation-1" };
        },
        async findScoped() {
            state.scopedLookups += 1;
            state.preparationFinished.resolve();
            return { id: "conversation-1" } as never;
        },
        async touch() {},
    };
    const messages = {
        async append() {
            state.userMessageAppends += 1;
            return { id: "message-1" } as never;
        },
        async listForConversation() {
            return [];
        },
        async listHistoryForConversation() {
            return [];
        },
    };
    const runner = {
        async execute() {
            state.executions += 1;
        },
    };
    const dependencies = {
        resourceAccess,
        conversations,
        messages,
        modelResolver: { resolve: () => "gpt-4o-mini" },
        clock: { now: () => new Date(0) },
        runner,
    };
    const start = new StartBookChat(dependencies as never);
    const append = new AppendBookChat(dependencies as never);
    return { state, start, append };
};

const createApp = async (start: unknown, append: unknown) => {
    const testApp = await createTestApp({
        controllers: [ChatController],
        providers: [
            { provide: START_BOOK_CHAT, useValue: start },
            { provide: APPEND_BOOK_CHAT, useValue: append },
            {
                provide: LIST_BOOK_CONVERSATIONS,
                useValue: { execute: async () => [] },
            },
            {
                provide: GET_BOOK_CONVERSATION,
                useValue: { execute: async () => [] },
            },
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
        user: { id: "user-1" } as never,
    });
    return testApp;
};

const sendPost = (baseUrl: string, path: string, message = "question") => {
    const url = new URL(baseUrl);
    const req = http.request({
        host: url.hostname,
        port: Number(url.port),
        method: "POST",
        path,
        headers: { "content-type": "application/json" },
    });
    req.on("error", () => {});
    req.on("response", (res) => res.resume());
    req.end(JSON.stringify({ message }));
    return req;
};

const disconnectDuringPrepare = async (path: string, create: boolean) => {
    const barrier = createAuthorizationBarrier();
    const { state, start, append } = createPreparedApp(barrier);
    const testApp = await createApp(start, append);
    const observed = observeRequest(testApp.app.getHttpServer(), path);
    const disposed = deferred();
    onSessionDisposed = disposed.resolve;
    let clientRequest: http.ClientRequest | undefined;
    try {
        clientRequest = sendPost(testApp.baseUrl, path);
        await withTimeout(barrier.started.promise, "resource authorization");
        assert.equal(observed.records.length, 1);
        const record = observed.records[0];
        const serverClosed = deferred();
        if (record.res.destroyed) {
            serverClosed.resolve();
        } else {
            record.res.once("close", serverClosed.resolve);
        }
        clientRequest.destroy();
        await withTimeout(serverClosed.promise, "client socket close");
        barrier.release();
        await withTimeout(
            state.preparationFinished.promise,
            "preparation to finish"
        );
        await withTimeout(disposed.promise, "controller handler to settle");
        await waitForListenerCleanup(record);

        assert.equal(record.writeCount, 0);
        assert.equal(record.endCount, 0);
        assert.equal(state.userMessageAppends, 0);
        assert.equal(state.executions, 0);
        assert.equal(state.conversationCreates, create ? 1 : 0);
        assert.equal(state.scopedLookups, create ? 0 : 1);
    } finally {
        barrier.release();
        clientRequest?.destroy();
        observed.dispose();
        onSessionDisposed = () => {};
        await testApp.close();
    }
};

test("create route settles without writes when the client disconnects during authorization", async () => {
    await disconnectDuringPrepare("/api/book/book-1/conversations", true);
});

test("append route settles without writes when the client disconnects during authorization", async () => {
    await disconnectDuringPrepare(
        "/api/book/book-1/conversations/conversation-1/messages",
        false
    );
});

test("pre-stream validation keeps its JSON response and removes SSE listeners", async () => {
    const barrier = createAuthorizationBarrier();
    const { start, append } = createPreparedApp(barrier);
    const testApp = await createApp(start, append);
    const path = "/api/book/book-1/conversations";
    const observed = observeRequest(testApp.app.getHttpServer(), path);
    const disposed = deferred();
    onSessionDisposed = disposed.resolve;
    try {
        const response = await fetch(`${testApp.baseUrl}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message: "   " }),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {
            error: "Message is required",
        });
        await withTimeout(disposed.promise, "validation handler to settle");
        assert.equal(observed.records.length, 1);
        await waitForListenerCleanup(observed.records[0]);
    } finally {
        observed.dispose();
        onSessionDisposed = () => {};
        await testApp.close();
    }
});

test("unexpected create and append errors are logged before returning JSON 500", async () => {
    const createError = new Error("create preparation failed");
    const appendError = new Error("append preparation failed");
    const testApp = await createApp(
        {
            prepare: async () => {
                throw createError;
            },
        },
        {
            prepare: async () => {
                throw appendError;
            },
        }
    );
    const errors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
        const createResponse = await fetch(
            `${testApp.baseUrl}/api/book/book-1/conversations`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ message: "question" }),
            }
        );
        assert.equal(createResponse.status, 500);
        assert.deepEqual(await createResponse.json(), {
            error: "An error occurred",
        });

        const appendResponse = await fetch(
            `${testApp.baseUrl}/api/book/book-1/conversations/conversation-1/messages`,
            {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ message: "question" }),
            }
        );
        assert.equal(appendResponse.status, 500);
        assert.deepEqual(await appendResponse.json(), {
            error: "An error occurred",
        });

        assert.ok(
            errors.some(
                ([message, error]) =>
                    message === "Error in chat stream" && error === createError
            )
        );
        assert.ok(
            errors.some(
                ([message, error]) =>
                    message === "Error in chat messages" &&
                    error === appendError
            )
        );
    } finally {
        console.error = originalConsoleError;
        await testApp.close();
    }
});
