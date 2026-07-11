import assert from "node:assert/strict";
import test from "node:test";
import { createOriginalUploadKey } from "../src/utils/uploadKeys";

test("upload keys are user and book scoped", () => {
    const first = createOriginalUploadKey(
        "user-a",
        "11111111-1111-1111-1111-111111111111"
    );
    const second = createOriginalUploadKey(
        "user-b",
        "22222222-2222-2222-2222-222222222222"
    );

    assert.equal(
        first,
        "users/user-a/books/11111111-1111-1111-1111-111111111111/original"
    );
    assert.equal(
        second,
        "users/user-b/books/22222222-2222-2222-2222-222222222222/original"
    );
    assert.notEqual(first, second);
});
