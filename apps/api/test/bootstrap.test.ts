import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Controller, Get } from "@nestjs/common";
import { createTestApp } from "./helpers/nestApp";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = "http://localhost:5173";

const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");

const throwingDb = new Proxy(
    {},
    {
        get: (_target, prop) => {
            if (
                typeof prop === "symbol" ||
                prop === "then" ||
                prop === "catch" ||
                prop === "finally" ||
                prop === "onModuleInit" ||
                prop === "onApplicationBootstrap" ||
                prop === "onModuleDestroy" ||
                prop === "beforeApplicationShutdown" ||
                prop === "onApplicationShutdown"
            ) {
                return undefined;
            }
            return () => {
                throw new Error(
                    "unexpected database access in bootstrap tests"
                );
            };
        },
    }
);

type NestApp = Awaited<ReturnType<typeof createTestApp>>["app"];

let app: NestApp;
let baseUrl: string;
let closeApp: () => Promise<void>;

before(async () => {
    const testApp = await createTestApp({
        fullStack: true,
        db: throwingDb,
        overrides: [
            {
                token: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
    });
    app = testApp.app;
    baseUrl = testApp.baseUrl;
    closeApp = testApp.close;
});

after(async () => {
    await closeApp();
});

test("GET /health reaches the legacy router through Nest", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
});

test("GET / returns Hello World from the Nest controller", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "Hello World");
});

test("POST /api/user without an Origin is rejected by the CSRF middleware", async () => {
    const res = await fetch(`${baseUrl}/api/user`, { method: "POST" });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
        message: "Untrusted request origin",
    });
});

test("POST /api/auth/logout with a trusted origin clears the auth cookies", async () => {
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 204);
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.length > 0);
});

test("GET /health echoes an allowed origin in the CORS headers", async () => {
    const res = await fetch(`${baseUrl}/health`, {
        headers: { Origin: "http://localhost:5173" },
    });
    assert.equal(res.status, 200);
    assert.equal(
        res.headers.get("access-control-allow-origin"),
        "http://localhost:5173"
    );
});

test("GET /does-not-exist returns a JSON 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.statusCode, 404);
});

@Controller()
class PingController {
    @Get("ping")
    ping() {
        return { pong: true };
    }
}

test("createTestApp helper serves a testing-module controller", async () => {
    const testApp = await createTestApp({ controllers: [PingController] });
    try {
        const res = await fetch(`${testApp.baseUrl}/ping`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { pong: true });
    } finally {
        await testApp.close();
    }
});
