import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { AuthController } =
    require("../src/auth/auth.controller") as typeof import("../src/auth/auth.controller");
const { DRIZZLE } =
    require("../src/database/database.module") as typeof import("../src/database/database.module");
const { AUTH_OPERATIONS } =
    require("../src/auth/auth.operations") as typeof import("../src/auth/auth.operations");
const { generateToken, getOrCreateDevUser } =
    require("../src/services/AuthService") as typeof import("../src/services/AuthService");
const { RATE_LIMIT_CLIENT } =
    require("../src/common/rate-limit.module") as typeof import("../src/common/rate-limit.module");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");

const OWNER_USER = {
    id: "owner-1",
    email: "owner@example.com",
    name: "Owner",
    image: null,
    googleId: "google-owner",
    password: null,
    username: "owner",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
};

const GOOGLE_PAYLOAD = {
    sub: "google-owner",
    email: "owner@example.com",
    name: "Owner",
    picture: undefined,
};

type DbScript = {
    select?: unknown[] | Error;
    insert?: unknown[] | Error;
    update?: unknown[] | Error;
};

const fakeDb = (script: DbScript) => {
    const resolve = (value: unknown[] | Error | undefined) => {
        if (value instanceof Error) throw value;
        return value ?? [];
    };
    return {
        select: () => ({
            from: () => ({
                where: async () => resolve(script.select),
            }),
        }),
        insert: () => ({
            values: () => ({
                returning: async () => resolve(script.insert),
            }),
        }),
        update: () => ({
            set: () => ({
                where: () => ({
                    returning: async () => resolve(script.update),
                }),
            }),
        }),
    };
};

const createAuthTestApp = (
    options: {
        db?: unknown;
        verifyGoogleToken?: (idToken?: string) => Promise<unknown>;
        getOrCreateDevUser?: () => Promise<unknown>;
    } = {}
) => {
    const db = options.db ?? {};
    return createTestApp({
        controllers: [AuthController],
        providers: [
            { provide: DRIZZLE, useValue: db },
            {
                provide: AUTH_OPERATIONS,
                useValue: {
                    verifyGoogleToken:
                        options.verifyGoogleToken ??
                        (async () => {
                            throw new Error("Failed to verify token");
                        }),
                    generateToken,
                    getOrCreateDevUser:
                        options.getOrCreateDevUser ??
                        (() => getOrCreateDevUser(db as never)),
                },
            },
            {
                provide: RATE_LIMIT_CLIENT,
                useValue: { get: () => null, close: async () => {} },
            },
        ],
    });
};

const withNodeEnv = async <T>(value: string, fn: () => Promise<T>) => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = value;
    try {
        return await fn();
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
    }
};

const findCookie = (cookies: string[], name: string) =>
    cookies.find((cookie) => cookie.startsWith(`${name}=`));

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
    try {
        await withNodeEnv("production", async () => {
            const res = await fetch(`${testApp.baseUrl}/api/auth/dev`, {
                method: "POST",
            });
            assert.equal(res.status, 404);
            assert.deepEqual(await res.json(), { message: "Not found" });
        });
    } finally {
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

test("POST /api/auth/google without idToken fails before Google verification", async () => {
    const verified: string[] = [];
    const testApp = await createAuthTestApp({
        verifyGoogleToken: async (idToken?: string) => {
            if (!idToken) throw new Error("Failed to verify token");
            verified.push(idToken);
            return GOOGLE_PAYLOAD;
        },
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), {
            message: "Authentication failed",
        });
        assert.equal(verified.length, 0);
        assert.equal(res.headers.getSetCookie().length, 0);
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/google inserts a new user and sets the dev session cookie", async () => {
    const verified: string[] = [];
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: [], insert: [OWNER_USER] }),
        verifyGoogleToken: async (idToken?: string) => {
            if (!idToken) throw new Error("Failed to verify token");
            verified.push(idToken);
            return GOOGLE_PAYLOAD;
        },
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: "valid-google" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { user: OWNER_USER });
        assert.deepEqual(verified, ["valid-google"]);
        const cookie = findCookie(res.headers.getSetCookie(), "reader_session");
        assert.ok(cookie);
        assert.match(cookie, /Max-Age=604800/);
        assert.match(cookie, /Path=\//);
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        assert.doesNotMatch(cookie, /Secure/);
        assert.equal(
            findCookie(res.headers.getSetCookie(), "__Host-reader_session"),
            undefined
        );
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/google updates an existing user", async () => {
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: [OWNER_USER], update: [OWNER_USER] }),
        verifyGoogleToken: async () => GOOGLE_PAYLOAD,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: "valid-google" }),
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { user: OWNER_USER });
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/google sets the hardened __Host cookie in production", async () => {
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: [OWNER_USER], update: [OWNER_USER] }),
        verifyGoogleToken: async () => GOOGLE_PAYLOAD,
    });
    try {
        await withNodeEnv("production", async () => {
            const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ idToken: "valid-google" }),
            });
            assert.equal(res.status, 200);
            const cookie = findCookie(
                res.headers.getSetCookie(),
                "__Host-reader_session"
            );
            assert.ok(cookie);
            assert.match(cookie, /Max-Age=604800/);
            assert.match(cookie, /Path=\//);
            assert.match(cookie, /HttpOnly/);
            assert.match(cookie, /Secure/);
            assert.match(cookie, /SameSite=None/);
        });
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/google maps a database failure to 401 without a cookie", async () => {
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: new Error("db down") }),
        verifyGoogleToken: async () => GOOGLE_PAYLOAD,
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/google`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken: "valid-google" }),
        });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), {
            message: "Authentication failed",
        });
        assert.equal(res.headers.getSetCookie().length, 0);
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/dev inserts the dev user when missing", async () => {
    const devUser = {
        ...OWNER_USER,
        id: "dev-1",
        email: "dev@example.com",
        name: "Dev User",
        username: "dev",
    };
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: [], insert: [devUser] }),
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/dev`, {
            method: "POST",
        });
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { user: devUser });
        assert.ok(findCookie(res.headers.getSetCookie(), "reader_session"));
    } finally {
        await testApp.close();
    }
});

test("POST /api/auth/dev maps a database failure to 500", async () => {
    const testApp = await createAuthTestApp({
        db: fakeDb({ select: new Error("db down") }),
    });
    try {
        const res = await fetch(`${testApp.baseUrl}/api/auth/dev`, {
            method: "POST",
        });
        assert.equal(res.status, 500);
        assert.deepEqual(await res.json(), { message: "Dev auth failed" });
    } finally {
        await testApp.close();
    }
});
