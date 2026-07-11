import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

function readWorkspaceFile(path: string): string {
    return readFileSync(join(resolve(__dirname, "../../.."), path), "utf8");
}

test("progress migration cleans existing data before adding database constraints", () => {
    const migration = readWorkspaceFile(
        "apps/api/migrations/0012_medical_next_avengers.sql"
    );

    assert.match(
        migration,
        /UPDATE "progress"\s+SET "book_id" = "books"\."id"::text/
    );
    assert.match(migration, /DELETE FROM "progress"\s+WHERE NOT EXISTS/);
    assert.match(migration, /WHERE "book_id" !~\*/);
    assert.match(migration, /row_number\(\) OVER/);
    assert.match(
        migration,
        /ALTER TABLE "progress" ALTER COLUMN "book_id" SET DATA TYPE uuid USING "book_id"::uuid/
    );
    assert.match(
        migration,
        /ADD CONSTRAINT "progress_user_id_book_id_pk" PRIMARY KEY\("user_id","book_id"\)/
    );
    assert.match(
        migration,
        /ADD CONSTRAINT "progress_book_id_books_id_fk" FOREIGN KEY \("book_id"\) REFERENCES "public"\."books"\("id"\) ON DELETE cascade/
    );
    assert.match(
        migration,
        /ADD CONSTRAINT "progress_user_id_users_id_fk" FOREIGN KEY \("user_id"\) REFERENCES "public"\."users"\("id"\) ON DELETE cascade/
    );
});

test("progress snapshot has uuid book IDs, composite primary key, and foreign keys", () => {
    const snapshot = JSON.parse(
        readWorkspaceFile("apps/api/migrations/meta/0012_snapshot.json")
    );
    const progress = snapshot.tables["public.progress"];

    assert.equal(progress.columns.book_id.type, "uuid");
    assert.deepEqual(
        progress.compositePrimaryKeys.progress_user_id_book_id_pk.columns,
        ["user_id", "book_id"]
    );
    assert.equal(
        progress.foreignKeys.progress_book_id_books_id_fk.onDelete,
        "cascade"
    );
    assert.deepEqual(
        progress.foreignKeys.progress_book_id_books_id_fk.columnsFrom,
        ["book_id"]
    );
    assert.deepEqual(
        progress.foreignKeys.progress_book_id_books_id_fk.columnsTo,
        ["id"]
    );
    assert.equal(
        progress.foreignKeys.progress_user_id_users_id_fk.onDelete,
        "cascade"
    );
    assert.deepEqual(
        progress.foreignKeys.progress_user_id_users_id_fk.columnsFrom,
        ["user_id"]
    );
    assert.deepEqual(
        progress.foreignKeys.progress_user_id_users_id_fk.columnsTo,
        ["id"]
    );
});
