import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createTestApp } from "../test/helpers/nestApp";
import { closeDatabasePool } from "../src/db";
import { Users } from "../src/db/schema";
import { GOOGLE_IDENTITY_VERIFIER } from "../src/auth/auth.tokens";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const database = drizzle(pool);
const googleId = "auth-integration-google";
const googleEmail = "google-auth-integration@example.invalid";
const devEmail = process.env.DEV_USER_EMAIL!;
let baseUrl = "";
let closeApp: () => Promise<void> = async () => {};
let googleCookie = "";

before(async () => {
    assert.ok(process.env.DATABASE_URL);
    const app = await createTestApp({
        fullStack: true,
        overrides: [
            {
                token: GOOGLE_IDENTITY_VERIFIER,
                useValue: {
                    verify: async (token: string) => {
                        assert.ok(
                            token === "google-first" ||
                                token === "google-second"
                        );
                        return {
                            sub: googleId,
                            email: googleEmail,
                            name: "Google Integration",
                        };
                    },
                },
            },
        ],
    });
    baseUrl = app.baseUrl;
    closeApp = app.close;
});

after(async () => {
    await closeApp();
    await database.delete(Users).where(eq(Users.googleId, googleId));
    await database.delete(Users).where(eq(Users.email, devEmail));
    await closeDatabasePool();
    await pool.end();
});

test("Google sign-in creates an account, then touches it on the next sign-in", async () => {
    const first = await fetch(`${baseUrl}/api/auth/google`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:5173",
        },
        body: JSON.stringify({ idToken: "google-first" }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
        user: { id: string; googleId: string; image: string | null };
    };
    assert.equal(firstBody.user.googleId, googleId);
    assert.equal(firstBody.user.image, null);
    googleCookie =
        first.headers
            .getSetCookie()
            .find((cookie) => cookie.startsWith("reader_session="))
            ?.split(";")[0] ?? "";
    assert.ok(googleCookie);

    const [created] = await database
        .select()
        .from(Users)
        .where(eq(Users.googleId, googleId));
    assert.ok(created);

    const oldUpdatedAt = new Date("2020-01-01T00:00:00.000Z");
    await database
        .update(Users)
        .set({ updatedAt: oldUpdatedAt })
        .where(eq(Users.id, created.id));

    const second = await fetch(`${baseUrl}/api/auth/google`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Origin: "http://localhost:5173",
        },
        body: JSON.stringify({ idToken: "google-second" }),
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
        user: { id: string; updatedAt: string };
    };
    assert.equal(secondBody.user.id, created.id);
    assert.ok(new Date(secondBody.user.updatedAt) > oldUpdatedAt);
});

test("development sign-in creates a user and then finds the same user", async () => {
    const signIn = () =>
        fetch(`${baseUrl}/api/auth/dev`, {
            method: "POST",
            headers: { Origin: "http://localhost:5173" },
        });
    const first = await signIn();
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
        user: { id: string; email: string; username: string | null };
    };
    assert.equal(firstBody.user.email, devEmail);
    assert.equal(firstBody.user.username, "dev");

    const second = await signIn();
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
        user: { id: string };
    };
    assert.equal(secondBody.user.id, firstBody.user.id);
});

test("Google session cookie authenticates /api/user", async () => {
    const response = await fetch(`${baseUrl}/api/user`, {
        headers: { Cookie: googleCookie },
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { user: { googleId: string } };
    assert.equal(body.user.googleId, googleId);
});
