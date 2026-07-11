import assert from "node:assert/strict";
import test from "node:test";
import {
    getNextChapter,
    getTextBlockNavigationTarget,
    isLastChapter,
} from "../src/lib/readerNavigationBounds";

const chapters = [
    { id: "chapter-1", hrefId: "chapter-1.xhtml" },
    { id: "chapter-2", hrefId: "chapter-2.xhtml" },
];

test("detects the last chapter and does not advance past it", () => {
    assert.equal(isLastChapter(chapters, chapters[1]), true);
    assert.equal(getNextChapter(chapters, chapters[1]), null);
});

test("returns the next chapter when one exists", () => {
    assert.equal(isLastChapter(chapters, chapters[0]), false);
    assert.deepEqual(getNextChapter(chapters, chapters[0]), chapters[1]);
});

test("ArrowDown at the last text block does not advance out of bounds", () => {
    const blocks = [{ id: "block-1" }, { id: "block-2" }];

    assert.equal(
        getTextBlockNavigationTarget(blocks, "block-2", "ArrowDown"),
        null
    );
});

test("missing active text block falls back to the first block", () => {
    const blocks = [{ id: "block-1" }, { id: "block-2" }];

    assert.deepEqual(
        getTextBlockNavigationTarget(blocks, "missing-block", "ArrowDown"),
        blocks[0]
    );
});

test("empty text blocks do not produce a navigation target", () => {
    assert.equal(getTextBlockNavigationTarget([], null, "ArrowDown"), null);
});
