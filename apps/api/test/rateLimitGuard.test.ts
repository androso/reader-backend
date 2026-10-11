import assert from "node:assert/strict";
import test from "node:test";
import {
    CanActivate,
    Controller,
    Get,
    HttpException,
    Injectable,
    UseGuards,
    type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import {
    AuthRateLimitGuard,
    ChatRateLimitGuard,
    UploadRateLimitGuard,
    createRateLimitGuard,
    fixedWindowScript,
} from "../src/common/guards/rate-limit.guard";
import {
    RATE_LIMIT_CLIENT,
    createRateLimitClientOwner,
    type RateLimitClientFactory,
    type RateLimitClientOwner,
} from "../src/common/rate-limit.module";
import type { User } from "../src/types";
import { createTestApp } from "./helpers/nestApp";

type EvalCall = {
    script: string;
    numKeys: number;
    key: string;
    windowSeconds: number;
};

const createFakeRedis = (options: {
    status?: string;
    result?: [number, number];
    connectError?: Error;
    evalError?: Error;
    quitError?: Error;
}) => {
    const calls: EvalCall[] = [];
    const client = {
        status: options.status ?? "ready",
        connectCalls: 0,
        evalCalls: calls,
        quitCalls: 0,
        disconnectCalls: 0,
        async connect() {
            client.connectCalls += 1;
            if (options.connectError) throw options.connectError;
        },
        async eval(
            script: string,
            numKeys: number,
            key: string,
            windowSeconds: number
        ) {
            calls.push({ script, numKeys, key, windowSeconds });
            if (options.evalError) throw options.evalError;
            return options.result ?? [1, 60];
        },
        async quit() {
            client.quitCalls += 1;
            if (options.quitError) throw options.quitError;
            return "OK";
        },
        disconnect() {
            client.disconnectCalls += 1;
        },
    };
    return client;
};

const ownerReturning = (get: () => unknown): RateLimitClientOwner => ({
    get: get as RateLimitClientOwner["get"],
    close: async () => undefined,
});

const fakeHttpContext = (req: Record<string, unknown>) => {
    const headers: Record<string, string> = {};
    const res = {
        setHeader: (name: string, value: string) => {
            headers[name.toLowerCase()] = value;
        },
    };
    const context = {
        switchToHttp: () => ({
            getRequest: () => req,
            getResponse: () => res,
        }),
    } as unknown as ExecutionContext;
    return { context, headers };
};

const withFrozenTime = async <T>(ms: number, fn: () => Promise<T>) => {
    const original = Date.now;
    Date.now = () => ms;
    try {
        return await fn();
    } finally {
        Date.now = original;
    }
};

const withRedisUrl = async <T>(
    value: string | undefined,
    fn: () => Promise<T> | T
) => {
    const previous = process.env.REDIS_URL;
    if (value === undefined) Reflect.deleteProperty(process.env, "REDIS_URL");
    else process.env.REDIS_URL = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined)
            Reflect.deleteProperty(process.env, "REDIS_URL");
        else process.env.REDIS_URL = previous;
    }
};

const authRequest = (req: Record<string, unknown>) =>
    fakeHttpContext({ socket: {}, ...req });

test("fixedWindowScript is the exact historical Lua fixed-window script", () => {
    assert.equal(
        fixedWindowScript,
        `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return {count, redis.call("TTL", KEYS[1])}
`
    );
});

test("auth guard uses req.ip identity with a 20/900s fixed window", async () => {
    const redis = createFakeRedis({ result: [1, 42] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({
        ip: "203.0.113.7",
        socket: { remoteAddress: "198.51.100.2" },
    });
    const ms = 1_700_000_000_000;
    const allowed = await withFrozenTime(ms, () => guard.canActivate(context));
    assert.equal(allowed, true);
    assert.equal(redis.evalCalls.length, 1);
    const [call] = redis.evalCalls;
    assert.equal(call.script, fixedWindowScript);
    assert.equal(call.numKeys, 1);
    assert.equal(
        call.key,
        `reader:rate:auth:203.0.113.7:${Math.floor(ms / 900_000)}`
    );
    assert.equal(call.windowSeconds, 900);
});

test("auth guard falls back to socket remote address then unknown", async () => {
    const redis = createFakeRedis({ result: [1, 5] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const ms = 1_700_000_000_000;
    const bucket = Math.floor(ms / 900_000);

    const viaSocket = authRequest({
        ip: "",
        socket: { remoteAddress: "198.51.100.9" },
    });
    await withFrozenTime(ms, () => guard.canActivate(viaSocket.context));
    assert.equal(
        redis.evalCalls[0].key,
        `reader:rate:auth:198.51.100.9:${bucket}`
    );

    const viaUnknown = authRequest({ ip: undefined, socket: {} });
    await withFrozenTime(ms, () => guard.canActivate(viaUnknown.context));
    assert.equal(redis.evalCalls[1].key, `reader:rate:auth:unknown:${bucket}`);
});

test("upload guard uses the authenticated user id with a 10/3600s window", async () => {
    const redis = createFakeRedis({ result: [1, 12] });
    const guard = new UploadRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ user: { id: "owner-9" } });
    const ms = 1_700_000_000_000;
    await withFrozenTime(ms, () => guard.canActivate(context));
    assert.equal(
        redis.evalCalls[0].key,
        `reader:rate:upload:owner-9:${Math.floor(ms / 3_600_000)}`
    );
    assert.equal(redis.evalCalls[0].windowSeconds, 3600);
});

test("chat guard uses the authenticated user id with a 30/60s window", async () => {
    const redis = createFakeRedis({ result: [1, 12] });
    const guard = new ChatRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ user: { id: "owner-9" } });
    const ms = 1_700_000_000_000;
    await withFrozenTime(ms, () => guard.canActivate(context));
    assert.equal(
        redis.evalCalls[0].key,
        `reader:rate:chat:owner-9:${Math.floor(ms / 60_000)}`
    );
    assert.equal(redis.evalCalls[0].windowSeconds, 60);
});

test("counts at limit-1 and limit pass while limit+1 rejects with 429", async () => {
    const req = { ip: "203.0.113.7", socket: {} };
    for (const count of [19, 20]) {
        const redis = createFakeRedis({ result: [count, 9] });
        const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
        const { context } = fakeHttpContext(req);
        assert.equal(await guard.canActivate(context), true);
    }
    const redis = createFakeRedis({ result: [21, 9] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context, headers } = fakeHttpContext(req);
    await assert.rejects(guard.canActivate(context), (error) => {
        assert.ok(error instanceof HttpException);
        assert.equal((error as HttpException).getStatus(), 429);
        assert.deepEqual((error as HttpException).getResponse(), {
            error: "Too many requests",
        });
        return true;
    });
    assert.equal(headers["retry-after"], "9");
});

test("Retry-After is Math.max(ttl, 1)", async () => {
    const req = { user: { id: "u" } };
    for (const [ttl, expected] of [
        [-5, "1"],
        [0, "1"],
        [17, "17"],
    ] as const) {
        const redis = createFakeRedis({ result: [31, ttl] });
        const guard = new ChatRateLimitGuard(ownerReturning(() => redis));
        const { context, headers } = fakeHttpContext(req);
        await assert.rejects(guard.canActivate(context));
        assert.equal(headers["retry-after"], expected);
    }
});

test("bucket rollover produces a different key for a later window", async () => {
    const redis = createFakeRedis({ result: [1, 1] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const req = { ip: "203.0.113.7", socket: {} };
    const ms = 1_700_000_000_000;
    const bucket = Math.floor(ms / 900_000);
    const { context } = fakeHttpContext(req);
    await withFrozenTime(ms, () => guard.canActivate(context));
    await withFrozenTime(ms + 900_000, () => guard.canActivate(context));
    assert.equal(
        redis.evalCalls[0].key,
        `reader:rate:auth:203.0.113.7:${bucket}`
    );
    assert.equal(
        redis.evalCalls[1].key,
        `reader:rate:auth:203.0.113.7:${bucket + 1}`
    );
});

test("a wait-state client is connected before eval", async () => {
    const redis = createFakeRedis({ status: "wait", result: [1, 5] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    assert.equal(await guard.canActivate(context), true);
    assert.equal(redis.connectCalls, 1);
    assert.equal(redis.evalCalls.length, 1);
});

test("a connected client is not reconnected", async () => {
    const redis = createFakeRedis({ status: "ready", result: [1, 5] });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    await guard.canActivate(context);
    assert.equal(redis.connectCalls, 0);
});

test("a null owner result passes through without eval", async () => {
    const guard = new AuthRateLimitGuard(ownerReturning(() => null));
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    assert.equal(await guard.canActivate(context), true);
});

test("connect failures fail open", async () => {
    const redis = createFakeRedis({
        status: "wait",
        connectError: new Error("connect refused"),
    });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    assert.equal(await guard.canActivate(context), true);
    assert.equal(redis.connectCalls, 1);
    assert.equal(redis.evalCalls.length, 0);
});

test("eval failures fail open", async () => {
    const redis = createFakeRedis({
        evalError: new Error("redis blew up"),
    });
    const guard = new AuthRateLimitGuard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    assert.equal(await guard.canActivate(context), true);
});

test("an owner get() failure propagates instead of failing open", async () => {
    const failure = new Error("client factory broken");
    const guard = new AuthRateLimitGuard(
        ownerReturning(() => {
            throw failure;
        })
    );
    const { context } = fakeHttpContext({ ip: "1.2.3.4", socket: {} });
    await assert.rejects(guard.canActivate(context), (error) => {
        assert.strictEqual(error, failure);
        return true;
    });
});

test("custom namespaces use the same reader:rate key shape", async () => {
    const redis = createFakeRedis({ result: [2, 3] });
    const Guard = createRateLimitGuard("probe", 5, 120, () => "who");
    const guard = new Guard(ownerReturning(() => redis));
    const { context } = fakeHttpContext({});
    const ms = 1_700_000_000_000;
    await withFrozenTime(ms, () => guard.canActivate(context));
    assert.equal(
        redis.evalCalls[0].key,
        `reader:rate:probe:who:${Math.floor(ms / 120_000)}`
    );
    assert.equal(redis.evalCalls[0].windowSeconds, 120);
});

const fakeUser: User = {
    id: "rl-user",
    email: "rl@example.com",
    name: "Rate Limited",
    image: null,
    googleId: "google-rl",
    username: "rluser",
    password: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
};

let handlerCalls = 0;

@Injectable()
class SetUserGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
        context.switchToHttp().getRequest<Request>().user = fakeUser;
        return true;
    }
}

@Controller("limited")
@UseGuards(SetUserGuard, UploadRateLimitGuard)
class LimitedController {
    @Get()
    get() {
        handlerCalls += 1;
        return { ok: true };
    }
}

test("a 429 from a real guarded route never reaches the handler", async () => {
    handlerCalls = 0;
    const redis = createFakeRedis({ result: [11, 4] });
    const testApp = await createTestApp({
        controllers: [LimitedController],
        providers: [
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: ownerReturning(() => redis),
            },
        ],
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/limited`);
        assert.equal(res.status, 429);
        assert.deepEqual(await res.json(), { error: "Too many requests" });
        assert.equal(res.headers.get("retry-after"), "4");
        assert.equal(handlerCalls, 0);
    } finally {
        await testApp.close();
    }
});

test("an owner get() failure on a real route surfaces as a generic 500", async () => {
    handlerCalls = 0;
    const testApp = await createTestApp({
        controllers: [LimitedController],
        providers: [
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: ownerReturning(() => {
                    throw new Error("client factory broken");
                }),
            },
        ],
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/limited`);
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), {
            error: "Internal server error",
        });
        assert.equal(handlerCalls, 0);
    } finally {
        await testApp.close();
    }
});

test("owner.get() returns null without REDIS_URL and never creates a client", async () => {
    await withRedisUrl(undefined, () => {
        let created = 0;
        const owner = createRateLimitClientOwner((() => {
            created += 1;
            return createFakeRedis({});
        }) as unknown as RateLimitClientFactory);
        assert.equal(owner.get(), null);
        assert.equal(created, 0);
    });
});

test("owner.get() creates the client lazily once with the historical options", async () => {
    await withRedisUrl("redis://fake:6379", () => {
        const factoryCalls: { url: string; options: unknown }[] = [];
        const clients: ReturnType<typeof createFakeRedis>[] = [];
        const owner = createRateLimitClientOwner(((
            url: string,
            options: unknown
        ) => {
            factoryCalls.push({ url, options });
            const client = createFakeRedis({});
            clients.push(client);
            return client;
        }) as unknown as RateLimitClientFactory);
        const first = owner.get();
        const second = owner.get();
        assert.ok(first);
        assert.strictEqual(first, second);
        assert.strictEqual(first, clients[0]);
        assert.equal(factoryCalls.length, 1);
        assert.equal(factoryCalls[0].url, "redis://fake:6379");
        assert.deepEqual(factoryCalls[0].options, {
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            enableOfflineQueue: false,
        });
    });
});

test("concurrent close() calls share one in-flight promise", async () => {
    await withRedisUrl("redis://fake:6379", async () => {
        const clients: ReturnType<typeof createFakeRedis>[] = [];
        const owner = createRateLimitClientOwner((() => {
            const client = createFakeRedis({});
            clients.push(client);
            return client;
        }) as unknown as RateLimitClientFactory);
        owner.get();
        const first = owner.close();
        const second = owner.close();
        assert.strictEqual(first, second);
        await first;
        assert.equal(clients[0].quitCalls, 1);
        assert.equal(clients[0].disconnectCalls, 1);
    });
});

test("close() propagates quit failures but still disconnects", async () => {
    await withRedisUrl("redis://fake:6379", async () => {
        const failure = new Error("quit failed");
        const clients: ReturnType<typeof createFakeRedis>[] = [];
        const owner = createRateLimitClientOwner((() => {
            const client = createFakeRedis({ quitError: failure });
            clients.push(client);
            return client;
        }) as unknown as RateLimitClientFactory);
        owner.get();
        await assert.rejects(owner.close(), (error) => {
            assert.strictEqual(error, failure);
            return true;
        });
        assert.equal(clients[0].quitCalls, 1);
        assert.equal(clients[0].disconnectCalls, 1);
    });
});

test("close() disconnects a never-connected client without calling quit", async () => {
    await withRedisUrl("redis://fake:6379", async () => {
        const clients: ReturnType<typeof createFakeRedis>[] = [];
        const owner = createRateLimitClientOwner((() => {
            const client = createFakeRedis({ status: "wait" });
            clients.push(client);
            return client;
        }) as unknown as RateLimitClientFactory);
        owner.get();
        await owner.close();
        assert.equal(clients[0].quitCalls, 0);
        assert.equal(clients[0].disconnectCalls, 1);
    });
});

test("close() with no client resolves without work", async () => {
    await withRedisUrl("redis://fake:6379", async () => {
        const owner = createRateLimitClientOwner((() => {
            throw new Error("factory must not run");
        }) as unknown as RateLimitClientFactory);
        await owner.close();
    });
});

test("get() returns null after close() even with REDIS_URL set", async () => {
    await withRedisUrl("redis://fake:6379", async () => {
        const owner = createRateLimitClientOwner((() =>
            createFakeRedis({})) as unknown as RateLimitClientFactory);
        owner.get();
        await owner.close();
        assert.equal(owner.get(), null);
    });
});
