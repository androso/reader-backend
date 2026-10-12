import assert from "node:assert/strict";
import test from "node:test";
import type { Account } from "@reader/domain";
import {
    AuthenticateSession,
    SignInForDevelopment,
    SignInWithGoogle,
} from "../src";

const account: Account = {
    id: "account-1",
    email: "reader@example.com",
    name: "Reader",
    image: null,
    googleId: "google-1",
    password: null,
    username: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
};

const now = new Date("2025-01-02T03:04:05.000Z");
const sessionTokens = {
    issue: (accountId: string) => `session:${accountId}`,
    verify: (token: string) => token.slice("session:".length),
};

test("SignInWithGoogle creates an account and issues a session", async () => {
    const calls: unknown[] = [];
    const result = await new SignInWithGoogle({
        googleIdentityVerifier: {
            verify: async (token) => {
                calls.push(["verify", token]);
                return {
                    sub: "google-1",
                    email: "reader@example.com",
                    name: "Reader",
                    picture: "https://example.invalid/picture",
                };
            },
        },
        accounts: {
            findByGoogleId: async (googleId) => {
                calls.push(["findByGoogleId", googleId]);
                return null;
            },
            createFromGoogle: async (input) => {
                calls.push(["createFromGoogle", input]);
                return account;
            },
            touchByGoogleId: async () => {
                throw new Error("unexpected touch");
            },
        },
        sessionTokens,
        clock: { now: () => now },
    }).execute("google-token");

    assert.deepEqual(calls, [
        ["verify", "google-token"],
        ["findByGoogleId", "google-1"],
        [
            "createFromGoogle",
            {
                googleId: "google-1",
                email: "reader@example.com",
                name: "Reader",
            },
        ],
    ]);
    assert.deepEqual(result, { account, token: "session:account-1" });
});

test("SignInWithGoogle touches an existing account with the injected clock", async () => {
    const calls: unknown[] = [];
    const result = await new SignInWithGoogle({
        googleIdentityVerifier: {
            verify: async () => ({
                sub: "google-1",
                email: "reader@example.com",
                name: "Reader",
            }),
        },
        accounts: {
            findByGoogleId: async () => account,
            createFromGoogle: async () => {
                throw new Error("unexpected create");
            },
            touchByGoogleId: async (...args) => {
                calls.push(args);
                return { ...account, updatedAt: args[1] };
            },
        },
        sessionTokens,
        clock: { now: () => now },
    }).execute("google-token");

    assert.deepEqual(calls, [["google-1", now]]);
    assert.equal(result.account.updatedAt, now);
    assert.equal(result.token, "session:account-1");
});

test("SignInForDevelopment creates an account when missing", async () => {
    const calls: unknown[] = [];
    const result = await new SignInForDevelopment({
        accounts: {
            findByEmail: async (email) => {
                calls.push(["findByEmail", email]);
                return null;
            },
            createDev: async (input) => {
                calls.push(["createDev", input]);
                return account;
            },
        },
        sessionTokens,
        config: { enabled: true, email: "reader@example.com", name: "Reader" },
    }).execute();

    assert.deepEqual(calls, [
        ["findByEmail", "reader@example.com"],
        ["createDev", { email: "reader@example.com", name: "Reader" }],
    ]);
    assert.deepEqual(result, { account, token: "session:account-1" });
});

test("SignInForDevelopment returns an existing account without creating it", async () => {
    let creates = 0;
    const result = await new SignInForDevelopment({
        accounts: {
            findByEmail: async () => account,
            createDev: async () => {
                creates += 1;
                return account;
            },
        },
        sessionTokens,
        config: { enabled: true, email: account.email, name: account.name },
    }).execute();

    assert.equal(creates, 0);
    assert.equal(result.account, account);
});

test("SignInForDevelopment rejects disabled production auth before repository access", async () => {
    let reads = 0;
    await assert.rejects(
        new SignInForDevelopment({
            accounts: {
                findByEmail: async () => {
                    reads += 1;
                    return account;
                },
                createDev: async () => account,
            },
            sessionTokens,
            config: {
                enabled: false,
                email: account.email,
                name: account.name,
            },
        }).execute(),
        /Dev auth is not available in production/
    );
    assert.equal(reads, 0);
});

test("AuthenticateSession returns null and reports invalid tokens", async () => {
    const failure = new Error("bad token");
    const errors: unknown[] = [];
    const result = await new AuthenticateSession({
        accounts: { findById: async () => account },
        sessionTokens: {
            issue: sessionTokens.issue,
            verify: () => {
                throw failure;
            },
        },
        onError: (error) => errors.push(error),
    }).execute("invalid");

    assert.equal(result, null);
    assert.deepEqual(errors, [failure]);
});

test("AuthenticateSession returns null when the account is missing", async () => {
    const errors: unknown[] = [];
    const result = await new AuthenticateSession({
        accounts: { findById: async () => null },
        sessionTokens,
        onError: (error) => errors.push(error),
    }).execute("session:missing");

    assert.equal(result, null);
    assert.deepEqual(errors, []);
});

test("AuthenticateSession reports repository errors and returns null", async () => {
    const failure = new Error("database unavailable");
    const errors: unknown[] = [];
    const result = await new AuthenticateSession({
        accounts: {
            findById: async () => {
                throw failure;
            },
        },
        sessionTokens,
        onError: (error) => errors.push(error),
    }).execute("session:account-1");

    assert.equal(result, null);
    assert.deepEqual(errors, [failure]);
});
