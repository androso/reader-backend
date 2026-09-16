import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Controller, Get } from "@nestjs/common";
import { createTestApp } from "./helpers/nestApp";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";
process.env.FRONTEND_URL = "http://localhost:5173";

const { createApp } =
    require("../src/bootstrap") as typeof import("../src/bootstrap");

type NestApp = Awaited<ReturnType<typeof createApp>>;

let app: NestApp;
let baseUrl: string;

before(async () => {
    app = await createApp();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
    await app.close();
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
