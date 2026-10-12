import assert from "node:assert/strict";
import test from "node:test";

process.env.JWT_SECRET = process.env.JWT_SECRET ?? "reader-api-test-secret";

const { createGoogleIdentityVerifier, createJsonWebTokenSessionTokens } =
    require("../src/infrastructure/auth") as typeof import("../src/infrastructure/auth");
const { createTestApp } =
    require("./helpers/nestApp") as typeof import("./helpers/nestApp");
const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");

test("Google identity verification lazily creates its client and falls back to email for name", async () => {
    let clientCreations = 0;
    const verifier = createGoogleIdentityVerifier({
        getClientId: () => "test-client",
        createClient: (clientId) => {
            clientCreations += 1;
            assert.equal(clientId, "test-client");
            return {
                verifyIdToken: async ({ idToken, audience }) => {
                    assert.equal(idToken, "google-token");
                    assert.equal(audience, "test-client");
                    return {
                        getPayload: () => ({
                            sub: "google-1",
                            email: "reader@example.com",
                        }),
                    };
                },
            };
        },
        onError: () => {},
    });

    assert.equal(clientCreations, 0);
    assert.deepEqual(await verifier.verify("google-token"), {
        sub: "google-1",
        email: "reader@example.com",
        name: "reader@example.com",
        picture: undefined,
    });
    assert.equal(clientCreations, 1);
});

test("JWT session adapter issues and verifies a token with a seven-day expiry", () => {
    const secret = "auth-adapter-test-secret";
    const tokens = createJsonWebTokenSessionTokens(secret);
    const token = tokens.issue("account-1");
    const decoded = jwt.decode(token) as {
        userId: string;
        iat: number;
        exp: number;
    };

    assert.equal(tokens.verify(token), "account-1");
    assert.equal(decoded.userId, "account-1");
    assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60);
});

test("JWT session adapter rejects tampered and expired tokens", () => {
    const secret = "auth-adapter-test-secret";
    const tokens = createJsonWebTokenSessionTokens(secret);
    const valid = tokens.issue("account-1");
    const parts = valid.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
    const expired = jwt.sign({ userId: "account-1", iat: 1 }, secret, {
        expiresIn: "1s",
    });

    assert.throws(() => tokens.verify(tampered));
    assert.throws(() => tokens.verify(expired));
});

test("SessionModule initialization preserves the missing JWT_SECRET error", async () => {
    const previousSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "";
    try {
        await assert.rejects(
            createTestApp({ fullStack: true }),
            /Missing required JWT_SECRET environment variable/
        );
    } finally {
        if (previousSecret === undefined) process.env.JWT_SECRET = "";
        else process.env.JWT_SECRET = previousSecret;
    }
});
