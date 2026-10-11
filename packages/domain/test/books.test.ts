import assert from "node:assert/strict";
import test from "node:test";
import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookNotFoundError,
    BookProcessingQueueUnavailableError,
    getBookMimeType,
    createOriginalUploadKey,
    InvalidBookFileError,
    MissingBookFileError,
} from "../src";

test("book MIME types and original upload keys are stable", () => {
    assert.equal(getBookMimeType("pdf"), "application/pdf");
    assert.equal(getBookMimeType("epub"), "application/epub+zip");
    assert.equal(
        createOriginalUploadKey("user-1", "book-1"),
        "users/user-1/books/book-1/original"
    );
});

test("domain errors retain their public names and messages", () => {
    const errors = [
        [
            new MissingBookFileError(),
            "MissingBookFileError",
            "No file uploaded",
        ],
        [
            new InvalidBookFileError("bad signature"),
            "InvalidBookFileError",
            "bad signature",
        ],
        [
            new BookProcessingQueueUnavailableError("queue down"),
            "BookProcessingQueueUnavailableError",
            "queue down",
        ],
        [
            new BookNotFoundError("book-1"),
            "BookNotFoundError",
            "Book book-1 was not found",
        ],
        [
            new BookFileTypeMismatchError("book-1", "pdf", "epub"),
            "BookFileTypeMismatchError",
            "Book book-1 file type changed from pdf to epub",
        ],
        [
            new BookDeletedDuringProcessingError("book-1"),
            "BookDeletedDuringProcessingError",
            "Book book-1 was deleted during processing",
        ],
    ] as const;

    for (const [error, name, message] of errors) {
        assert.equal(error.name, name);
        assert.equal(error.message, message);
    }
});
