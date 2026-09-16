import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { AuthController } =
    require("../src/auth/auth.controller") as typeof import("../src/auth/auth.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

const createAuthTestApp = () =>
    createTestApp({
        controllers: [AuthController],
        providers: [{ provide: DRIZZLE, useValue: {} }],
    });

test("POST /api/auth/logout clears the auth cookies", async () => {
    const testApp = await createAuthTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/logout`, {
            method: "POST",
        });
        assert.equal(res.status, 204);
        assert.ok(res.headers.getSetCookie().length > 0);
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/dev returns 404 in production", async () => {
    const testApp = await createAuthTestApp();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/dev`, {
            method: "POST",
        });
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), { message: "Not found" });
    } finally {
        process.env.NODE_ENV = previous;
        await testApp.close();
    }
});

test("POST /api/auth/google with an invalid token returns 401", async () => {
    const testApp = await createAuthTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: "garbage" }),
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), {
            message: "Authentication failed",
        });
    } finally {
        await testApp.close();
    }
});
