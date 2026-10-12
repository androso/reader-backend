import assert from "node:assert/strict";
import test from "node:test";
import { ProgressValidationError, validateProgressInput } from "../src";

test("progress position preserves whitespace and chapter omission", () => {
    assert.deepEqual(validateProgressInput({ position: "  block-1  " }), {
        position: "  block-1  ",
        chapter: undefined,
    });
});

test("progress validation reports required position before other fields", () => {
    for (const position of [undefined, null, ""]) {
        assert.throws(
            () =>
                validateProgressInput({
                    position,
                    chapter: 42,
                }),
            (error: unknown) =>
                error instanceof ProgressValidationError &&
                error.code === "position_required" &&
                error.message === "Progress Block is required"
        );
    }
});

test("progress validation rejects non-string and whitespace-only positions", () => {
    for (const position of [123, " \t\n "]) {
        assert.throws(
            () => validateProgressInput({ position }),
            (error: unknown) =>
                error instanceof ProgressValidationError &&
                error.code === "position_invalid" &&
                error.message === "Progress Block must be a non-empty string"
        );
    }
});

test("progress chapter distinguishes omission, null, and invalid presence", () => {
    assert.equal(validateProgressInput({ position: "p1" }).chapter, undefined);
    assert.equal(
        validateProgressInput({ position: "p1", chapter: null }).chapter,
        null
    );
    assert.equal(
        validateProgressInput({ position: "p1", chapter: "" }).chapter,
        ""
    );

    for (const chapter of [undefined, 1, false, {}]) {
        assert.throws(
            () => validateProgressInput({ position: "p1", chapter }),
            (error: unknown) =>
                error instanceof ProgressValidationError &&
                error.code === "chapter_invalid" &&
                error.message === "Progress Chapter must be a string or null"
        );
    }
});
