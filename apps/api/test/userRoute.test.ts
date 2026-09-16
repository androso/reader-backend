import assert from "node:assert/strict";
import test from "node:test";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { UserController } =
    require("../src/user/user.controller") as typeof import("../src/user/user.controller");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

const fakeUser: User = {
    id: "user-1",
    email: "user@example.com",
    name: "Test User",
    image: null,
    googleId: "google-1",
    username: "testuser",
    password: null,
    createdAt: new Date("2024-01-01T00:00:00Z"),
    updatedAt: new Date("2024-01-01T00:00:00Z"),
};

test("GET /api/user returns the authenticated user", async () => {
    const testApp = await createTestApp({
        controllers: [UserController],
        user: fakeUser,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), {
            user: {
                ...fakeUser,
                createdAt: fakeUser.createdAt.toISOString(),
                updatedAt: fakeUser.updatedAt.toISOString(),
            },
        });
    } finally {
        await testApp.close();
    }
});

test("GET /api/user without a cookie is rejected", async () => {
    const testApp = await createTestApp({ controllers: [UserController] });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/user with a malformed cookie is rejected", async () => {
    const testApp = await createTestApp({ controllers: [UserController] });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: { Cookie: "reader_session=garbage" },
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Invalid token" });
    } finally {
        await testApp.close();
    }
});
