import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "@reader/domain";
import type { User } from "../src/types";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
const { UserController } =
    require("../src/user/user.controller") as typeof import("../src/user/user.controller");
const { AUTHENTICATE_SESSION } =
    require("../src/auth/auth.tokens") as typeof import("../src/auth/auth.tokens");
const { AuthenticateSession } =
    require("@reader/application") as typeof import("@reader/application");
const { createJsonWebTokenSessionTokens } =
    require("../src/infrastructure/auth") as typeof import("../src/infrastructure/auth");
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

const createUserTestApp = async () => {
    const lookupIds: string[] = [];
    const session = new AuthenticateSession({
        accounts: {
            findById: async (id: string) => {
                lookupIds.push(id);
                return fakeUser as Account;
            },
        },
        sessionTokens: createJsonWebTokenSessionTokens(process.env.JWT_SECRET!),
        onError: () => {},
    });
    const app = await createTestApp({
        controllers: [UserController],
        providers: [{ provide: AUTHENTICATE_SESSION, useValue: session }],
    });
    return { ...app, lookupIds };
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
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`);
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "No token provided" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/user with a malformed cookie is rejected", async () => {
    const testApp = await createUserTestApp();
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

const JWT_SECRET = process.env.JWT_SECRET!;

const validToken = () =>
    jwt.sign({ userId: fakeUser.id }, JWT_SECRET, { expiresIn: "7d" });

const expiredToken = () =>
    jwt.sign({ userId: fakeUser.id, iat: 1, exp: 2 }, JWT_SECRET, {
        noTimestamp: true,
    });

const tamperedToken = () => {
    const parts = validToken().split(".");
    const sig = parts[2];
    const flipped = (sig.startsWith("A") ? "B" : "A") + sig.slice(1);
    return `${parts[0]}.${parts[1]}.${flipped}`;
};

test("GET /api/user returns the authenticated principal without a second database lookup", async () => {
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: { Cookie: `reader_session=${validToken()}` },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.user.id, fakeUser.id);
        assert.equal(body.user.email, fakeUser.email);
        assert.deepEqual(testApp.lookupIds, [fakeUser.id]);
    } finally {
        await testApp.close();
    }
});

test("GET /api/user with an expired cookie is rejected", async () => {
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: { Cookie: `reader_session=${expiredToken()}` },
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Invalid token" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/user with a tampered cookie is rejected", async () => {
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: { Cookie: `reader_session=${tamperedToken()}` },
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Invalid token" });
    } finally {
        await testApp.close();
    }
});

test("GET /api/user prefers the production cookie when both are present", async () => {
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: {
                Cookie: `__Host-reader_session=${validToken()}; reader_session=garbage`,
            },
        });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.user.id, fakeUser.id);
        assert.deepEqual(testApp.lookupIds, [fakeUser.id]);
    } finally {
        await testApp.close();
    }
});

test("GET /api/user rejects when the preferred production cookie is tampered", async () => {
    const testApp = await createUserTestApp();
    try {
        const res = await fetch(`${testApp.baseUrl}/api/user`, {
            headers: {
                Cookie: `__Host-reader_session=${tamperedToken()}; reader_session=${validToken()}`,
            },
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { message: "Invalid token" });
    } finally {
        await testApp.close();
    }
});
