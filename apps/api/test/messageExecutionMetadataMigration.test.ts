import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

test("message execution metadata migration is nullable JSONB", () => {
    const migration = fs.readFileSync(
        path.resolve(
            process.cwd(),
            "migrations/0015_message_execution_metadata.sql"
        ),
        "utf8"
    );

    assert.match(
        migration,
        /ADD COLUMN "execution_metadata" jsonb;/
    );
    assert.doesNotMatch(migration, /NOT NULL/);
    assert.doesNotMatch(migration, /completion_status|finish_reason/);

    const snapshot = JSON.parse(
        fs.readFileSync(
            path.resolve(
                process.cwd(),
                "migrations/meta/0015_snapshot.json"
            ),
            "utf8"
        )
    );
    const columns = snapshot.tables["public.messages"].columns;
    assert.equal(columns.execution_metadata.type, "jsonb");
    assert.equal(columns.execution_metadata.notNull, false);
    assert.equal(columns.completion_status.type, "message_completion_status");
    assert.equal(columns.finish_reason.type, "text");
});
