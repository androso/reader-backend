import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET ??= "reader-api-test-secret";
process.env.LANGFUSE_SAMPLE_RATE ??= "0";

import { Controller, Get, Res } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Response } from "express";

const { attachApiLifecycle, createApiResources, runApiProcess } =
    require("../src/api-lifecycle") as typeof import("../src/api-lifecycle");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

const flush = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
};

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

const fakeExit = () => {
    const calls: number[] = [];
    return {
        calls,
        exit: (code: number) => {
            calls.push(code);
        },
    };
};

const fakeTimer = () => {
    const timers: { ms: number; onTimeout: () => void; cleared: boolean }[] =
        [];
    return {
        timers,
        setTimer: (ms: number, onTimeout: () => void) => {
            const timer = { ms, onTimeout, cleared: false };
            timers.push(timer);
            return timer;
        },
        clearTimer: (timer: unknown) => {
            (timer as { cleared: boolean }).cleared = true;
        },
        fire: (index = 0) => {
            const timer = timers[index];
            if (timer && !timer.cleared) timer.onTimeout();
        },
    };
};

const fakeApp = (overrides: {
    listen?: () => Promise<void>;
    close?: () => Promise<void>;
    getHttpServer?: () => unknown;
}) =>
    ({
        listen: async () => {},
        close: async () => {},
        getHttpServer: () => ({}),
        ...overrides,
    }) as unknown as NestExpressApplication;

type SignalListener = (signal: string) => void;

const fireSignal = (
    name: "SIGINT" | "SIGTERM",
    baseline: Set<SignalListener>
) => {
    for (const listener of process.listeners(name) as SignalListener[]) {
        if (!baseline.has(listener)) listener(name);
    }
};

const removeExtraListeners = (
    name: "SIGINT" | "SIGTERM",
    baseline: Set<SignalListener>
) => {
    for (const listener of process.listeners(name) as SignalListener[]) {
        if (!baseline.has(listener)) process.off(name, listener);
    }
};

const withSignalCleanup = async (
    fn: (fire: (name: "SIGINT" | "SIGTERM") => void) => Promise<void>
) => {
    const sigintBaseline = new Set(
        process.listeners("SIGINT") as SignalListener[]
    );
    const sigtermBaseline = new Set(
        process.listeners("SIGTERM") as SignalListener[]
    );
    try {
        await fn((name) =>
            fireSignal(
                name,
                name === "SIGINT" ? sigintBaseline : sigtermBaseline
            )
        );
    } finally {
        removeExtraListeners("SIGINT", sigintBaseline);
        removeExtraListeners("SIGTERM", sigtermBaseline);
    }
};

const fakeLogError = () => {
    const calls: { message: string; errors: unknown[] }[] = [];
    return {
        calls,
        logError: (message: string, errors: unknown[]) => {
            calls.push({ message, errors });
        },
    };
};

test("createApiResources closes producers together, then db, then tracing", async () => {
    const order: string[] = [];
    const book = deferred();
    const shadow = deferred();
    const rate = deferred();
    const resources = createApiResources({
        closeBookQueue: () => {
            order.push("book");
            return book.promise;
        },
        closeShadowQueue: () => {
            order.push("shadow");
            return shadow.promise;
        },
        closeRateLimit: () => {
            order.push("rate");
            return rate.promise;
        },
        closeDatabase: async () => {
            order.push("db");
        },
        shutdownTracing: async () => {
            order.push("trace");
        },
    });
    const closing = resources.close();
    await flush();
    assert.deepEqual(order, ["book", "shadow", "rate"]);
    book.resolve();
    shadow.resolve();
    await flush();
    assert.deepEqual(order, ["book", "shadow", "rate"]);
    rate.resolve();
    await closing;
    assert.deepEqual(order, ["book", "shadow", "rate", "db", "trace"]);
});

test("createApiResources waits all producers and still closes db+tracing when one rejects", async () => {
    const order: string[] = [];
    const book = deferred();
    const failure = new Error("shadow failed");
    const resources = createApiResources({
        closeBookQueue: () => {
            order.push("book");
            return book.promise;
        },
        closeShadowQueue: async () => {
            order.push("shadow");
            throw failure;
        },
        closeRateLimit: async () => {
            order.push("rate");
        },
        closeDatabase: async () => {
            order.push("db");
        },
        shutdownTracing: async () => {
            order.push("trace");
        },
    });
    const closing = resources.close();
    await flush();
    book.resolve();
    await assert.rejects(closing, (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(failure));
        return true;
    });
    assert.deepEqual(order, ["book", "shadow", "rate", "db", "trace"]);
});

test("createApiResources still attempts every resource when a producer throws synchronously", async () => {
    const order: string[] = [];
    const failure = new Error("sync book close failure");
    const resources = createApiResources({
        closeBookQueue: () => {
            order.push("book");
            throw failure;
        },
        closeShadowQueue: async () => {
            order.push("shadow");
        },
        closeRateLimit: async () => {
            order.push("rate");
        },
        closeDatabase: async () => {
            order.push("db");
        },
        shutdownTracing: async () => {
            order.push("trace");
        },
    });
    await assert.rejects(resources.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(failure));
        return true;
    });
    assert.deepEqual(order, ["book", "shadow", "rate", "db", "trace"]);
});

test("createApiResources still shuts down tracing when db close rejects", async () => {
    const order: string[] = [];
    const failure = new Error("db failed");
    const resources = createApiResources({
        closeBookQueue: async () => {
            order.push("book");
        },
        closeShadowQueue: async () => {
            order.push("shadow");
        },
        closeRateLimit: async () => {
            order.push("rate");
        },
        closeDatabase: async () => {
            order.push("db");
            throw failure;
        },
        shutdownTracing: async () => {
            order.push("trace");
        },
    });
    await assert.rejects(resources.close(), AggregateError);
    assert.deepEqual(order, ["book", "shadow", "rate", "db", "trace"]);
});

test("createApiResources memoizes the close promise", async () => {
    let calls = 0;
    const resources = createApiResources({
        closeBookQueue: async () => {
            calls += 1;
        },
        closeShadowQueue: async () => {},
        closeRateLimit: async () => {},
        closeDatabase: async () => {},
        shutdownTracing: async () => {},
    });
    const first = resources.close();
    const second = resources.close();
    assert.strictEqual(first, second);
    await Promise.all([first, second]);
    assert.equal(calls, 1);
});

test("createApiResources aggregates a tracing failure", async () => {
    const failure = new Error("tracing failed");
    const resources = createApiResources({
        closeBookQueue: async () => {},
        closeShadowQueue: async () => {},
        closeRateLimit: async () => {},
        closeDatabase: async () => {},
        shutdownTracing: async () => {
            throw failure;
        },
    });
    await assert.rejects(resources.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(failure));
        return true;
    });
});

test("attachApiLifecycle waits for the original close before resources", async () => {
    const order: string[] = [];
    const original = deferred();
    const app = fakeApp({
        close: () => {
            order.push("app.close");
            return original.promise;
        },
        getHttpServer: () => {
            throw new Error("native fallback must not run on success");
        },
    });
    attachApiLifecycle(app, {
        close: async () => {
            order.push("resources");
        },
    });
    const closing = app.close();
    await flush();
    assert.deepEqual(order, ["app.close"]);
    original.resolve();
    await closing;
    assert.deepEqual(order, ["app.close", "resources"]);
});

test("attachApiLifecycle drains the http server before resources when original close fails", async () => {
    const order: string[] = [];
    const failure = new Error("nest close failed");
    const serverDrained = deferred();
    const app = fakeApp({
        close: async () => {
            order.push("app.close");
            throw failure;
        },
        getHttpServer: () => ({
            close: (callback: (error?: Error) => void) => {
                order.push("server.close");
                void serverDrained.promise.then(() => callback());
            },
        }),
    });
    attachApiLifecycle(app, {
        close: async () => {
            order.push("resources");
        },
    });
    const closing = app.close();
    await flush();
    assert.deepEqual(order, ["app.close", "server.close"]);
    serverDrained.resolve();
    await assert.rejects(closing, AggregateError);
    assert.deepEqual(order, ["app.close", "server.close", "resources"]);
});

test("attachApiLifecycle tolerates only ERR_SERVER_NOT_RUNNING from the fallback", async () => {
    const notRunning = Object.assign(new Error("not running"), {
        code: "ERR_SERVER_NOT_RUNNING",
    });
    const order: string[] = [];
    const tolerated = fakeApp({
        close: async () => {
            throw new Error("nest close failed");
        },
        getHttpServer: () => ({
            close: (callback: (error?: Error) => void) => callback(notRunning),
        }),
    });
    attachApiLifecycle(tolerated, {
        close: async () => {
            order.push("resources");
        },
    });
    await assert.rejects(tolerated.close(), AggregateError);
    assert.deepEqual(order, ["resources"]);

    const realFailure = Object.assign(new Error("boom"), { code: "EIO" });
    const strict = fakeApp({
        close: async () => {
            throw new Error("nest close failed");
        },
        getHttpServer: () => ({
            close: (callback: (error?: Error) => void) => callback(realFailure),
        }),
    });
    attachApiLifecycle(strict, { close: async () => {} });
    await assert.rejects(strict.close(), (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(realFailure));
        return true;
    });
});

test("attachApiLifecycle shares a single close across calls", async () => {
    let calls = 0;
    const app = fakeApp({
        close: async () => {
            calls += 1;
        },
    });
    attachApiLifecycle(app, { close: async () => {} });
    const first = app.close();
    const second = app.close();
    assert.strictEqual(first, second);
    await first;
    assert.equal(calls, 1);
});

test("runApiProcess exits nonzero, reports once, and closes resources when startup fails", async () => {
    const { calls, exit } = fakeExit();
    const { calls: logCalls, logError } = fakeLogError();
    const timer = fakeTimer();
    const closed: string[] = [];
    const failure = new Error("createApp failed");
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    await withSignalCleanup(async () => {
        const proc = runApiProcess({
            createApp: async () => {
                throw failure;
            },
            resources: {
                close: async () => {
                    closed.push("resources");
                },
            },
            setTimer: timer.setTimer,
            clearTimer: timer.clearTimer,
            exit,
            logError,
        });
        await assert.rejects(proc.ready, /createApp failed/);
        await proc.shutdown();
        assert.deepEqual(calls, [1]);
        assert.deepEqual(closed, ["resources"]);
        assert.equal(timer.timers.length, 1);
        assert.equal(timer.timers[0].cleared, true);
        assert.equal(logCalls.length, 1);
        assert.equal(logCalls[0].message, "API startup or shutdown failed");
        assert.ok(logCalls[0].errors.includes(failure));
    });
    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
});

test("runApiProcess closes the created app and reports when listen fails", async () => {
    const { calls, exit } = fakeExit();
    const { calls: logCalls, logError } = fakeLogError();
    const timer = fakeTimer();
    const order: string[] = [];
    const failure = new Error("listen failed");
    const app = fakeApp({
        listen: async () => {
            order.push("listen");
            throw failure;
        },
        close: async () => {
            order.push("app.close");
        },
    });
    await withSignalCleanup(async () => {
        const proc = runApiProcess({
            createApp: async () => app,
            resources: {
                close: async () => {
                    order.push("resources");
                },
            },
            setTimer: timer.setTimer,
            clearTimer: timer.clearTimer,
            exit,
            logError,
        });
        await assert.rejects(proc.ready, /listen failed/);
        await proc.shutdown();
        assert.deepEqual(order, ["listen", "app.close"]);
        assert.deepEqual(calls, [1]);
        assert.equal(logCalls.length, 1);
        assert.equal(logCalls[0].message, "API startup or shutdown failed");
        assert.ok(logCalls[0].errors.includes(failure));
    });
});

test("runApiProcess shares one close across repeated signals and removes handlers", async () => {
    const { calls, exit } = fakeExit();
    const { calls: logCalls, logError } = fakeLogError();
    const timer = fakeTimer();
    const order: string[] = [];
    const app = fakeApp({
        listen: async () => {
            order.push("listen");
        },
        close: async () => {
            order.push("app.close");
        },
    });
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    await withSignalCleanup(async (fire) => {
        const proc = runApiProcess({
            createApp: async () => app,
            resources: {
                close: async () => {
                    order.push("resources");
                },
            },
            setTimer: timer.setTimer,
            clearTimer: timer.clearTimer,
            exit,
            logError,
        });
        await proc.ready;
        fire("SIGINT");
        fire("SIGINT");
        fire("SIGTERM");
        await proc.shutdown();
        assert.deepEqual(calls, [0]);
        assert.deepEqual(
            order.filter((entry) => entry === "app.close"),
            ["app.close"]
        );
        assert.deepEqual(logCalls, []);
    });
    assert.equal(process.listenerCount("SIGINT"), sigintBefore);
    assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
});

test("runApiProcess shutdown waits for a pending startup before closing", async () => {
    const { calls, exit } = fakeExit();
    const timer = fakeTimer();
    const order: string[] = [];
    const started = deferred<NestExpressApplication>();
    const app = fakeApp({
        close: async () => {
            order.push("app.close");
        },
    });
    await withSignalCleanup(async (fire) => {
        const proc = runApiProcess({
            createApp: () => started.promise,
            resources: {
                close: async () => {
                    order.push("resources");
                },
            },
            setTimer: timer.setTimer,
            clearTimer: timer.clearTimer,
            exit,
        });
        fire("SIGTERM");
        await flush();
        assert.deepEqual(order, []);
        assert.equal(timer.timers.length, 1);
        started.resolve(app);
        await proc.ready;
        await proc.shutdown();
        assert.deepEqual(order, ["app.close"]);
        assert.deepEqual(calls, [0]);
    });
});

test("runApiProcess timeout exits 1 exactly once and blocks a later exit 0", async () => {
    const { calls, exit } = fakeExit();
    const timer = fakeTimer();
    const order: string[] = [];
    const closeDone = deferred();
    const app = fakeApp({
        close: () => {
            order.push("app.close");
            return closeDone.promise;
        },
    });
    await withSignalCleanup(async (fire) => {
        const proc = runApiProcess({
            createApp: async () => app,
            resources: {
                close: async () => {
                    order.push("resources");
                },
            },
            setTimer: timer.setTimer,
            clearTimer: timer.clearTimer,
            exit,
        });
        await proc.ready;
        fire("SIGINT");
        await flush();
        assert.equal(timer.timers.length, 1);
        assert.equal(timer.timers[0].ms, 10000);
        timer.fire();
        assert.deepEqual(calls, [1]);
        closeDone.resolve();
        await proc.shutdown();
        assert.deepEqual(calls, [1]);
        assert.equal(timer.timers[0].cleared, true);
    });
});

let sseResponse: Response | undefined;

const currentSseResponse = (): Response | undefined => sseResponse;

@Controller("lifecycle-test")
class SseController {
    @Get("events")
    events(@Res() res: Response) {
        res.setHeader("content-type", "text/event-stream");
        res.write("data: open\n\n");
        sseResponse = res;
    }
}

test(
    "attachApiLifecycle drains an open SSE response before closing resources",
    { timeout: 5000 },
    async () => {
        sseResponse = undefined;
        const testApp = await createTestApp({ controllers: [SseController] });
        const order: string[] = [];
        attachApiLifecycle(testApp.app, {
            close: async () => {
                order.push("resources");
            },
        });
        try {
            const response = await fetch(
                `${testApp.baseUrl}/lifecycle-test/events`
            );
            assert.equal(response.status, 200);
            const handle = currentSseResponse();
            assert.ok(handle, "expected the sse response handle");
            const closing = testApp.app.close();
            let settled = false;
            void closing.then(() => {
                settled = true;
            });
            await flush(12);
            assert.equal(settled, false);
            assert.deepEqual(order, []);
            handle.end();
            await closing;
            assert.equal(settled, true);
            assert.deepEqual(order, ["resources"]);
            await response.arrayBuffer().catch(() => {});
        } finally {
            currentSseResponse()?.end();
            await testApp.close();
        }
    }
);
