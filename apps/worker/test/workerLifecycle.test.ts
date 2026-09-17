import "reflect-metadata";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Processor, Worker, WorkerOptions } from "bullmq";
import { Test } from "@nestjs/testing";
import { createWorkerApp } from "../src/bootstrap";
import { runWorkerProcess } from "../src/index";
import { createWorkerResources, WorkerModule } from "../src/worker.module";
import {
    WORKER_FACTORY,
    WORKER_RESOURCES,
    WORKER_RUNTIME_DEPENDENCIES,
    WorkerRuntimeService,
    type WorkerFactory,
    type WorkerResources,
    type WorkerRuntimeDependencies,
} from "../src/worker-runtime.service";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const deferred = <T = void>() => {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
};

class FakeWorker extends EventEmitter {
    closeCalls = 0;
    private closeImpl: () => Promise<void> = () => Promise.resolve();
    setClose(impl: () => Promise<void>): void {
        this.closeImpl = impl;
    }
    close(): Promise<void> {
        this.closeCalls += 1;
        return this.closeImpl();
    }
}

interface RecordedWorkerCall {
    queueName: string;
    processor: Processor<any>;
    options: WorkerOptions;
    worker: FakeWorker;
}

const createRecordingFactory = () => {
    const calls: RecordedWorkerCall[] = [];
    const factory: WorkerFactory = <T>(
        queueName: string,
        processor: Processor<T>,
        options: WorkerOptions
    ): Worker<T> => {
        const worker = new FakeWorker();
        calls.push({ queueName, processor, options, worker });
        return worker as unknown as Worker<T>;
    };
    return { calls, factory };
};

const createDeps = (overrides: Partial<WorkerRuntimeDependencies> = {}) => {
    const logs: unknown[][] = [];
    const errorLogs: unknown[][] = [];
    const deps: WorkerRuntimeDependencies = {
        processBookProcessingJob: async () => {},
        processRagRerankShadowJob: async () => ({ status: "ok" }),
        getRedisConnectionOptions: () => ({
            url: "redis://worker-test.invalid:6379",
            maxRetriesPerRequest: null,
        }),
        getRagRerankShadowRateLimit: () => 30,
        logger: {
            log: (...args: unknown[]) => {
                logs.push(args);
            },
            error: (...args: unknown[]) => {
                errorLogs.push(args);
            },
        },
        ...overrides,
    };
    return { deps, logs, errorLogs };
};

const createResources = (closeImpl?: () => Promise<void>) => {
    const traceNames: string[] = [];
    let closeCalls = 0;
    const resources: WorkerResources = {
        startTracing: (serviceName: string) => {
            traceNames.push(serviceName);
        },
        close: () => {
            closeCalls += 1;
            return closeImpl ? closeImpl() : Promise.resolve();
        },
    };
    return { resources, traceNames, getCloseCalls: () => closeCalls };
};

const createProcessDeps = () => {
    const emitter = new EventEmitter();
    const exits: number[] = [];
    const errorLogs: unknown[][] = [];
    return {
        emitter,
        exits,
        errorLogs,
        signals: {
            on: (signal: NodeJS.Signals, listener: () => void) => {
                emitter.on(signal, listener);
            },
            removeListener: (signal: NodeJS.Signals, listener: () => void) => {
                emitter.removeListener(signal, listener);
            },
        },
        exit: (code: number) => {
            exits.push(code);
        },
        logError: (...args: unknown[]) => {
            errorLogs.push(args);
        },
    };
};

test("importing the worker entrypoint registers no signal handlers", async () => {
    const before = {
        sigint: process.listenerCount("SIGINT"),
        sigterm: process.listenerCount("SIGTERM"),
    };
    const entrypoint = await import("../src/index");
    assert.equal(typeof entrypoint.runWorkerProcess, "function");
    assert.equal(process.listenerCount("SIGINT"), before.sigint);
    assert.equal(process.listenerCount("SIGTERM"), before.sigterm);
});

test("module providers create no consumers or tracing before init", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    const { resources, traceNames, getCloseCalls } = createResources();

    const context = await Test.createTestingModule({ imports: [WorkerModule] })
        .overrideProvider(WORKER_FACTORY)
        .useValue(factory)
        .overrideProvider(WORKER_RUNTIME_DEPENDENCIES)
        .useValue(deps)
        .overrideProvider(WORKER_RESOURCES)
        .useValue(resources)
        .compile();

    try {
        assert.equal(calls.length, 0);
        assert.equal(traceNames.length, 0);
        assert.equal(
            typeof (context as unknown as { listen?: unknown }).listen,
            "undefined"
        );

        await context.init();
        assert.equal(calls.length, 2);

        await context.close();
        assert.equal(calls[0].worker.closeCalls, 1);
        assert.equal(calls[1].worker.closeCalls, 1);
        assert.equal(getCloseCalls(), 1);

        await context.close();
        assert.equal(calls[0].worker.closeCalls, 1);
        assert.equal(calls[1].worker.closeCalls, 1);
        assert.equal(getCloseCalls(), 1);
    } finally {
        await context.close().catch(() => {});
    }
});

test("runtime constructs both workers with exact queue options", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps, logs } = createDeps();
    const { resources } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    assert.equal(calls.length, 2);
    assert.equal(calls[0].queueName, "book-processing");
    assert.deepEqual(calls[0].options, {
        connection: {
            url: "redis://worker-test.invalid:6379",
            maxRetriesPerRequest: null,
        },
    });
    assert.equal(calls[1].queueName, "rag-rerank-shadow");
    assert.deepEqual(calls[1].options, {
        connection: {
            url: "redis://worker-test.invalid:6379",
            maxRetriesPerRequest: null,
        },
        concurrency: 2,
        maxStartedAttempts: 1,
        limiter: { max: 30, duration: 60000 },
    });
    assert.deepEqual(logs.slice(-2), [
        ["Book processing worker listening on book-processing"],
        ["RAG shadow worker listening on rag-rerank-shadow"],
    ]);
});

test("missing redis config creates zero consumers and closes resources", async () => {
    const missingRedis = new Error(
        "Missing required REDIS_URL environment variable"
    );
    const { deps } = createDeps({
        getRedisConnectionOptions: () => {
            throw missingRedis;
        },
    });
    const { calls, factory } = createRecordingFactory();
    const { resources, getCloseCalls } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await assert.rejects(service.onApplicationBootstrap(), (error) => {
        assert.equal(error, missingRedis);
        return true;
    });
    assert.equal(calls.length, 0);
    assert.equal(getCloseCalls(), 1);
});

test("invalid shadow rate limit creates zero consumers and closes resources", async () => {
    const invalidRate = new Error(
        "RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE must be a positive integer"
    );
    const { deps } = createDeps({
        getRagRerankShadowRateLimit: () => {
            throw invalidRate;
        },
    });
    const { calls, factory } = createRecordingFactory();
    const { resources, getCloseCalls } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await assert.rejects(service.onApplicationBootstrap(), (error) => {
        assert.equal(error, invalidRate);
        return true;
    });
    assert.equal(calls.length, 0);
    assert.equal(getCloseCalls(), 1);
});

test("processor callbacks delegate jobs to runtime dependencies", async () => {
    const bookJobs: unknown[] = [];
    const shadowJobs: unknown[] = [];
    const { deps } = createDeps({
        processBookProcessingJob: async (job) => {
            bookJobs.push(job);
        },
        processRagRerankShadowJob: async (job) => {
            shadowJobs.push(job);
            return { status: "ok" };
        },
    });
    const { calls, factory } = createRecordingFactory();
    const { resources } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const bookJob = {
        id: "book-job-1",
        attemptsMade: 0,
        opts: {},
        data: {
            bookId: "book-1",
            userId: "user-1",
            fileKey: "key",
            fileType: "epub",
        },
    };
    const shadowJob = {
        id: "shadow-job-1",
        data: {
            assistantMessageId: "assistant-1",
            userMessageId: "user-message-1",
            conversationId: "conversation-1",
            bookId: "book-1",
            userId: "user-1",
        },
    };

    await calls[0].processor(bookJob as any);
    await calls[1].processor(shadowJob as any);

    assert.deepEqual(bookJobs, [bookJob]);
    assert.deepEqual(shadowJobs, [shadowJob]);
});

test("event listeners log original messages with content-free metadata", async () => {
    const { deps, logs, errorLogs } = createDeps();
    const { calls, factory } = createRecordingFactory();
    const { resources } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const bookWorker = calls[0].worker;
    const shadowWorker = calls[1].worker;

    bookWorker.emit("completed", { id: "book-job-1" });
    assert.deepEqual(logs[logs.length - 1], [
        "Book processing job book-job-1 completed",
    ]);

    const bookFailure = new Error("book boom");
    bookWorker.emit("failed", undefined, bookFailure);
    assert.equal(
        errorLogs[errorLogs.length - 1][0],
        "Book processing job unknown failed"
    );
    assert.equal(errorLogs[errorLogs.length - 1][1], bookFailure);

    bookWorker.emit("failed", { id: "book-job-2" }, bookFailure);
    assert.equal(
        errorLogs[errorLogs.length - 1][0],
        "Book processing job book-job-2 failed"
    );

    shadowWorker.emit("completed", { id: "shadow-job-1" });
    assert.deepEqual(logs[logs.length - 1], [
        "RAG shadow job shadow-job-1 completed",
    ]);

    const shadowFailure = new TypeError("shadow boom");
    shadowWorker.emit("failed", { id: "shadow-job-2" }, shadowFailure);
    assert.equal(errorLogs[errorLogs.length - 1][0], "RAG shadow job failed");
    assert.deepEqual(errorLogs[errorLogs.length - 1][1], {
        jobId: "shadow-job-2",
        errorName: "TypeError",
    });

    shadowWorker.emit("failed", undefined, shadowFailure);
    assert.deepEqual(errorLogs[errorLogs.length - 1][1], {
        jobId: "unknown",
        errorName: "TypeError",
    });
});

test("repeat onApplicationBootstrap does not create extra consumers", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    const { resources } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();
    await service.onApplicationBootstrap();
    assert.equal(calls.length, 2);

    await service.close();
    await service.onApplicationBootstrap();
    assert.equal(calls.length, 2);
});

test("second consumer construction failure closes the first consumer and resources", async () => {
    const failure = new Error("shadow worker construction failed");
    const created: FakeWorker[] = [];
    const factory: WorkerFactory = <T>(
        _queueName: string,
        _processor: Processor<T>,
        _options: WorkerOptions
    ): Worker<T> => {
        if (created.length === 1) throw failure;
        const worker = new FakeWorker();
        created.push(worker);
        return worker as unknown as Worker<T>;
    };
    const { deps } = createDeps();
    const { resources, getCloseCalls } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await assert.rejects(service.onApplicationBootstrap(), (error) => {
        assert.equal(error, failure);
        return true;
    });
    assert.equal(created.length, 1);
    assert.equal(created[0].closeCalls, 1);
    assert.equal(getCloseCalls(), 1);
});

test("startup failure aggregates with cleanup failure", async () => {
    const failure = new Error("shadow worker construction failed");
    const cleanupFailure = new Error("resource close failed");
    let constructed = 0;
    const factory: WorkerFactory = <T>(
        _queueName: string,
        _processor: Processor<T>,
        _options: WorkerOptions
    ): Worker<T> => {
        constructed += 1;
        if (constructed === 2) throw failure;
        return new FakeWorker() as unknown as Worker<T>;
    };
    const { deps } = createDeps();
    const { resources } = createResources(() => Promise.reject(cleanupFailure));
    const service = new WorkerRuntimeService(factory, deps, resources);

    await assert.rejects(service.onApplicationBootstrap(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], failure);
        assert.ok(error.errors[1] instanceof AggregateError);
        assert.deepEqual((error.errors[1] as AggregateError).errors, [
            cleanupFailure,
        ]);
        return true;
    });
});

test("close starts every consumer drain before waiting and closes resources last", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    const order: string[] = [];
    const { resources } = createResources(async () => {
        order.push("resources");
    });
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const first = deferred<void>();
    const second = deferred<void>();
    calls[0].worker.setClose(() => {
        order.push("book");
        return first.promise;
    });
    calls[1].worker.setClose(() => {
        order.push("shadow");
        return second.promise;
    });

    const closing = service.close();
    await flush();
    assert.equal(calls[0].worker.closeCalls, 1);
    assert.equal(calls[1].worker.closeCalls, 1);

    first.resolve();
    await flush();
    assert.deepEqual(order, ["book", "shadow"]);

    second.resolve();
    await closing;
    assert.deepEqual(order, ["book", "shadow", "resources"]);
});

test("close waits for all consumers before resources even when one fails", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    let resourcesClosed = false;
    const { resources } = createResources(async () => {
        resourcesClosed = true;
    });
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const first = deferred<void>();
    const second = deferred<void>();
    const drainFailure = new Error("book drain failed");
    calls[0].worker.setClose(() => first.promise);
    calls[1].worker.setClose(() => second.promise);

    const closing = service.close();
    await flush();

    first.reject(drainFailure);
    await flush();
    assert.equal(resourcesClosed, false);

    second.resolve();
    await assert.rejects(closing, (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "Worker shutdown failed");
        assert.deepEqual(error.errors, [drainFailure]);
        return true;
    });
    assert.equal(resourcesClosed, true);
});

test("close aggregates consumer failures and resource failure", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    const resourceFailure = new Error("resources failed");
    const { resources } = createResources(() =>
        Promise.reject(resourceFailure)
    );
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const bookFailure = new Error("book close failed");
    const shadowFailure = new Error("shadow close failed");
    calls[0].worker.setClose(() => Promise.reject(bookFailure));
    calls[1].worker.setClose(() => Promise.reject(shadowFailure));

    await assert.rejects(service.close(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.message, "Worker shutdown failed");
        assert.deepEqual(error.errors, [
            bookFailure,
            shadowFailure,
            resourceFailure,
        ]);
        return true;
    });
});

test("repeat close and onModuleDestroy reuse a single teardown", async () => {
    const { calls, factory } = createRecordingFactory();
    const { deps } = createDeps();
    const { resources, getCloseCalls } = createResources();
    const service = new WorkerRuntimeService(factory, deps, resources);

    await service.onApplicationBootstrap();

    const first = service.close();
    const second = service.close();
    assert.equal(first, second);
    await first;

    assert.equal(calls[0].worker.closeCalls, 1);
    assert.equal(calls[1].worker.closeCalls, 1);
    assert.equal(getCloseCalls(), 1);

    await service.onModuleDestroy();
    assert.equal(calls[0].worker.closeCalls, 1);
    assert.equal(calls[1].worker.closeCalls, 1);
    assert.equal(getCloseCalls(), 1);
});

test("createWorkerResources attempts database then tracing and aggregates both failures", async () => {
    const order: string[] = [];
    const databaseFailure = new Error("database close failed");
    const tracingFailure = new Error("tracing close failed");
    const resources = createWorkerResources({
        closeDatabasePool: async () => {
            order.push("database");
            throw databaseFailure;
        },
        shutdownLangfuseTracing: async () => {
            order.push("tracing");
            throw tracingFailure;
        },
        startLangfuseTracing: () => {},
    });

    await assert.rejects(resources.close(), (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [databaseFailure, tracingFailure]);
        return true;
    });
    assert.deepEqual(order, ["database", "tracing"]);
    assert.equal(resources.close(), resources.close());
});

test("createWorkerResources delegates tracing start and memoizes close", async () => {
    const traced: string[] = [];
    let databaseCloses = 0;
    let tracingCloses = 0;
    const resources = createWorkerResources({
        closeDatabasePool: async () => {
            databaseCloses += 1;
        },
        shutdownLangfuseTracing: async () => {
            tracingCloses += 1;
        },
        startLangfuseTracing: (serviceName) => {
            traced.push(serviceName ?? "");
        },
    });

    resources.startTracing("reader-worker");
    assert.deepEqual(traced, ["reader-worker"]);

    await resources.close();
    await resources.close();
    assert.equal(databaseCloses, 1);
    assert.equal(tracingCloses, 1);
});

test("createWorkerApp rejects and cleans up resources on invalid configuration", async () => {
    const saved = {
        REDIS_URL: process.env.REDIS_URL,
        RATE_LIMIT: process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE,
        PUBLIC_KEY: process.env.LANGFUSE_PUBLIC_KEY,
        SECRET_KEY: process.env.LANGFUSE_SECRET_KEY,
        SAMPLE_RATE: process.env.LANGFUSE_SAMPLE_RATE,
    };
    delete process.env.REDIS_URL;
    delete process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE;
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.LANGFUSE_SAMPLE_RATE = "0";
    try {
        await assert.rejects(createWorkerApp(), /REDIS_URL/);
    } finally {
        if (saved.REDIS_URL !== undefined)
            process.env.REDIS_URL = saved.REDIS_URL;
        if (saved.RATE_LIMIT !== undefined)
            process.env.RAG_RERANK_SHADOW_RATE_LIMIT_PER_MINUTE =
                saved.RATE_LIMIT;
        if (saved.PUBLIC_KEY !== undefined)
            process.env.LANGFUSE_PUBLIC_KEY = saved.PUBLIC_KEY;
        if (saved.SECRET_KEY !== undefined)
            process.env.LANGFUSE_SECRET_KEY = saved.SECRET_KEY;
        if (saved.SAMPLE_RATE === undefined) {
            delete process.env.LANGFUSE_SAMPLE_RATE;
        } else {
            process.env.LANGFUSE_SAMPLE_RATE = saved.SAMPLE_RATE;
        }
    }
});

test("SIGTERM drains the application then exits 0 and removes handlers", async () => {
    const { emitter, exits, errorLogs, signals, exit, logError } =
        createProcessDeps();
    const appClose = deferred<void>();
    let closeCalls = 0;
    const app = {
        close: () => {
            closeCalls += 1;
            return appClose.promise;
        },
    };

    const done = runWorkerProcess({
        createApp: async () => app,
        signals,
        exit,
        logError,
    });
    await flush();

    emitter.emit("SIGTERM");
    await flush();
    assert.equal(closeCalls, 1);
    assert.deepEqual(exits, []);

    appClose.resolve();
    await done;
    assert.deepEqual(exits, [0]);
    assert.deepEqual(errorLogs, []);
    assert.equal(emitter.listenerCount("SIGTERM"), 0);
    assert.equal(emitter.listenerCount("SIGINT"), 0);
});

test("SIGINT drains as well and repeated signals reuse a single close", async () => {
    const { emitter, exits, signals, exit, logError } = createProcessDeps();
    const appClose = deferred<void>();
    let closeCalls = 0;
    const app = {
        close: () => {
            closeCalls += 1;
            return appClose.promise;
        },
    };

    const done = runWorkerProcess({
        createApp: async () => app,
        signals,
        exit,
        logError,
    });
    await flush();

    emitter.emit("SIGINT");
    emitter.emit("SIGINT");
    emitter.emit("SIGTERM");
    await flush();
    assert.equal(closeCalls, 1);
    assert.deepEqual(exits, []);

    appClose.resolve();
    await done;
    assert.deepEqual(exits, [0]);
    assert.equal(closeCalls, 1);
});

test("a signal during pending startup waits for startup then drains", async () => {
    const { emitter, exits, signals, exit, logError } = createProcessDeps();
    const appReady = deferred<{
        close: () => Promise<void>;
    }>();
    const appClose = deferred<void>();
    let closeCalls = 0;
    const app = {
        close: () => {
            closeCalls += 1;
            return appClose.promise;
        },
    };

    const done = runWorkerProcess({
        createApp: () => appReady.promise,
        signals,
        exit,
        logError,
    });
    emitter.emit("SIGTERM");
    await flush();
    assert.equal(closeCalls, 0);
    assert.deepEqual(exits, []);

    appReady.resolve(app);
    await flush();
    assert.equal(closeCalls, 1);

    appClose.resolve();
    await done;
    assert.deepEqual(exits, [0]);
});

test("startup rejection logs the failure, removes handlers, and exits 1", async () => {
    const { emitter, exits, errorLogs, signals, exit, logError } =
        createProcessDeps();
    const failure = new Error("startup failed");

    const done = runWorkerProcess({
        createApp: async () => {
            throw failure;
        },
        signals,
        exit,
        logError,
    });
    await done;

    assert.deepEqual(exits, [1]);
    assert.equal(errorLogs.length, 1);
    assert.equal(errorLogs[0][0], failure);
    assert.equal(emitter.listenerCount("SIGTERM"), 0);
    assert.equal(emitter.listenerCount("SIGINT"), 0);
});

test("synchronous createApp throw becomes a startup failure exit 1", async () => {
    const { exits, errorLogs, signals, exit, logError } = createProcessDeps();
    const failure = new Error("sync startup failed");

    const done = runWorkerProcess({
        createApp: () => {
            throw failure;
        },
        signals,
        exit,
        logError,
    });
    await done;

    assert.deepEqual(exits, [1]);
    assert.equal(errorLogs[0]?.[0], failure);
});

test("teardown rejection exits 1 without a successful exit", async () => {
    const { emitter, exits, errorLogs, signals, exit, logError } =
        createProcessDeps();
    const failure = new Error("teardown failed");
    const app = {
        close: () => Promise.reject(failure),
    };

    const done = runWorkerProcess({
        createApp: async () => app,
        signals,
        exit,
        logError,
    });
    await flush();

    emitter.emit("SIGTERM");
    await done;
    assert.deepEqual(exits, [1]);
    assert.equal(errorLogs[0]?.[0], failure);
    assert.equal(emitter.listenerCount("SIGTERM"), 0);
});
