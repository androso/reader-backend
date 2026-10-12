import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { DeleteOwnedBook, SaveReadingProgress } from "@reader/application";
import { BookNotFoundError } from "@reader/domain";
import { Pool } from "pg";
import { Books, Progress, Users } from "../src/db/schema";
import { createDrizzleBookRepository } from "../src/infrastructure/books/drizzleBookRepository";
import { createDrizzleReadingProgressRepository } from "../src/infrastructure/progress";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);
const repository = createDrizzleReadingProgressRepository(db as never);
let userId = "";
let bookId = "";

const makeBook = async (id = randomUUID()) => {
    await db.insert(Books).values({
        id,
        userId,
        title: "Progress integration",
        fileKey: `progress/${id}.pdf`,
        fileType: "pdf",
        collectionName: `collection-${id}`,
        processingStatus: "ready",
    });
    return id;
};

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};

const bounded = <T>(promise: Promise<T>, label: string, ms = 8_000) =>
    new Promise<T>((resolvePromise, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timed out waiting for ${label}`)),
            ms
        );
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolvePromise(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });

const waitForLock = async (applicationName: string) => {
    await bounded(
        (async () => {
            for (let attempt = 0; attempt < 100; attempt += 1) {
                const result = await pool.query(
                    "select 1 from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'",
                    [applicationName]
                );
                if (result.rowCount) return;
                await new Promise((resolvePromise) =>
                    setTimeout(resolvePromise, 50)
                );
            }
            throw new Error(`No lock wait observed for ${applicationName}`);
        })(),
        `${applicationName} lock wait`
    );
};

beforeEach(async () => {
    userId = randomUUID();
    await db.insert(Users).values({
        id: userId,
        email: `${userId}@progress-it.invalid`,
        name: "Progress integration",
    });
    bookId = await makeBook();
});

afterEach(async () => {
    await db.delete(Books).where(eq(Books.userId, userId));
    await db.delete(Users).where(eq(Users.id, userId));
});

after(async () => {
    await pool.end();
});

test("fresh migration permits a progress row with null chapter", async () => {
    const column = await pool.query(
        "select attnotnull from pg_attribute where attrelid = 'progress'::regclass and attname = 'progress_chapter'"
    );
    assert.equal(column.rows[0]?.attnotnull, false);

    const saved = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "position-1",
        chapter: undefined,
        now: new Date("2025-01-01T00:00:00Z"),
    });
    assert.equal(saved?.progressChapter, null);
});

test("upgrade from the previous migration preserves chapters and accepts null", async () => {
    const connectionString = process.env.PROGRESS_UPGRADE_DATABASE_URL;
    assert.ok(connectionString);
    const upgradePool = new Pool({ connectionString });
    const upgradeUserId = randomUUID();
    const firstBookId = randomUUID();
    const secondBookId = randomUUID();
    try {
        await upgradePool.query(
            "insert into users (id, email, name) values ($1, $2, $3)",
            [upgradeUserId, `${upgradeUserId}@upgrade.invalid`, "Upgrade"]
        );
        for (const id of [firstBookId, secondBookId]) {
            await upgradePool.query(
                "insert into books (id, title, user_id, file_key) values ($1, $2, $3, $4)",
                [id, "Upgrade", upgradeUserId, `upgrade/${id}`]
            );
        }
        const beforeMigration = await upgradePool.query(
            "select attnotnull from pg_attribute where attrelid = 'progress'::regclass and attname = 'progress_chapter'"
        );
        assert.equal(beforeMigration.rows[0]?.attnotnull, true);
        await upgradePool.query(
            "insert into progress (user_id, book_id, progress_position, progress_chapter) values ($1, $2, $3, $4)",
            [upgradeUserId, firstBookId, "position-old", "chapter-kept"]
        );

        const migration = readdirSync(
            resolve(process.cwd(), "apps/api/migrations")
        ).find((file) => /^0016_.*\.sql$/.test(file));
        assert.ok(migration);
        const upgraded = spawnSync(
            "pnpm",
            ["exec", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
            {
                cwd: process.cwd(),
                encoding: "utf8",
                env: {
                    ...process.env,
                    DATABASE_URL: connectionString,
                },
            }
        );
        assert.equal(
            upgraded.status,
            0,
            `${upgraded.stdout ?? ""}${upgraded.stderr ?? ""}`
        );

        const retained = await upgradePool.query(
            "select progress_chapter from progress where user_id = $1 and book_id = $2",
            [upgradeUserId, firstBookId]
        );
        assert.equal(retained.rows[0]?.progress_chapter, "chapter-kept");
        await upgradePool.query(
            "insert into progress (user_id, book_id, progress_position, progress_chapter) values ($1, $2, $3, null)",
            [upgradeUserId, secondBookId, "position-new"]
        );
        const nullable = await upgradePool.query(
            "select progress_chapter from progress where user_id = $1 and book_id = $2",
            [upgradeUserId, secondBookId]
        );
        assert.equal(nullable.rows[0]?.progress_chapter, null);
        assert.match(
            readFileSync(
                resolve(process.cwd(), "apps/api/migrations", migration),
                "utf8"
            ),
            /ALTER COLUMN "progress_chapter" DROP NOT NULL/
        );
    } finally {
        await upgradePool.end();
    }
});

test("omitted chapter creates null, preserves on update, and explicit null clears", async () => {
    const first = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "first",
        chapter: undefined,
        now: new Date("2025-01-01T00:00:00Z"),
    });
    assert.equal(first?.progressChapter, null);

    const withChapter = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "second",
        chapter: "chapter-2",
        now: new Date("2025-01-02T00:00:00Z"),
    });
    assert.equal(withChapter?.progressChapter, "chapter-2");

    const omittedUpdate = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "third",
        chapter: undefined,
        now: new Date("2025-01-03T00:00:00Z"),
    });
    assert.equal(omittedUpdate?.progressChapter, "chapter-2");

    const cleared = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "fourth",
        chapter: null,
        now: new Date("2025-01-04T00:00:00Z"),
    });
    assert.equal(cleared?.progressChapter, null);
});

test("repeated and concurrent saves keep one row and stable createdAt", async () => {
    const createdAt = new Date("2025-02-01T00:00:00Z");
    const initial = await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "initial",
        chapter: "chapter-1",
        now: createdAt,
    });
    await repository.saveForLiveOwnedBook({
        userId,
        bookId,
        position: "repeat",
        chapter: undefined,
        now: new Date("2025-02-02T00:00:00Z"),
    });
    await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
            repository.saveForLiveOwnedBook({
                userId,
                bookId,
                position: `concurrent-${index}`,
                chapter: undefined,
                now: new Date(`2025-02-0${index + 3}T00:00:00Z`),
            })
        )
    );
    const rows = await db
        .select()
        .from(Progress)
        .where(eq(Progress.bookId, bookId));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.createdAt.toISOString(), createdAt.toISOString());
    assert.equal(
        rows[0]?.lastReadAt.toISOString(),
        initial?.lastReadAt.toISOString()
    );
});

test("save-first lock allows progress commit before real book deletion cascades", async () => {
    const savePool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: "progress-save-wins",
    });
    const deletePool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: "progress-delete-waits",
    });
    const acquired = deferred();
    const release = deferred();
    const saveRepository = createDrizzleReadingProgressRepository(
        drizzle(savePool) as never,
        {
            afterBookLock: async () => {
                acquired.resolve();
                await release.promise;
            },
        }
    );
    const deletingBooks = createDrizzleBookRepository(
        drizzle(deletePool) as never
    );
    const deleteBook = new DeleteOwnedBook({
        reads: deletingBooks,
        deletion: deletingBooks,
        references: deletingBooks,
        cleanup: {
            defaultCollectionName: (id) => `collection-${id}`,
            deleteFile: async () => {},
            deleteVectorCollection: async () => {},
            deleteSearchChunks: async () => {},
            clearCache: () => {},
        },
        queue: { removePending: async () => {} },
        lock: {
            withLock: async (_id, callback) =>
                callback(new AbortController().signal),
        },
    });
    let deletion: Promise<void> | undefined;
    try {
        const save = saveRepository.saveForLiveOwnedBook({
            userId,
            bookId,
            position: "save-first",
            chapter: null,
            now: new Date(),
        });
        await bounded(acquired.promise, "save book lock");
        deletion = deleteBook.execute({ userId, bookId });
        await waitForLock("progress-delete-waits");
        release.resolve();
        assert.ok(await bounded(save, "save transaction"));
        await bounded(deletion, "book deletion");
        const rows = await db
            .select()
            .from(Progress)
            .where(eq(Progress.bookId, bookId));
        assert.equal(rows.length, 0);
    } finally {
        release.resolve();
        if (deletion) await Promise.allSettled([deletion]);
        await Promise.all([savePool.end(), deletePool.end()]);
    }
});

test("deletion-first lock makes the later save return not found", async () => {
    const lockPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: "progress-delete-wins-holder",
    });
    const savePool = new Pool({
        connectionString: process.env.DATABASE_URL,
        application_name: "progress-save-waits",
    });
    const client = await lockPool.connect();
    const saveRepository = createDrizzleReadingProgressRepository(
        drizzle(savePool) as never
    );
    const save = new SaveReadingProgress({
        repository: saveRepository,
        clock: { now: () => new Date() },
    });
    try {
        await client.query("begin");
        await client.query(
            "update books set processing_status = 'deleting' where id = $1",
            [bookId]
        );
        const pendingSave = save.execute({
            userId,
            bookId,
            position: "save-after-delete",
        });
        await waitForLock("progress-save-waits");
        await client.query("commit");
        await assert.rejects(
            bounded(pendingSave, "deletion-wins save"),
            BookNotFoundError
        );
        const rows = await db
            .select()
            .from(Progress)
            .where(eq(Progress.bookId, bookId));
        assert.equal(rows.length, 0);
    } finally {
        try {
            await client.query("rollback");
        } catch {}
        client.release();
        await Promise.all([lockPool.end(), savePool.end()]);
    }
});
