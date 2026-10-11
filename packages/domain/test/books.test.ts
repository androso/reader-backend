import assert from "node:assert/strict";
import test from "node:test";
import {
    BookDeletedDuringProcessingError,
    BookFileTypeMismatchError,
    BookAccessDeniedError,
    BookLifecycleLockTimeoutError,
    BookLifecycleLockUnavailableError,
    BookNotFoundError,
    BookNotRetryableError,
    BookProcessingBusyError,
    BookProcessingQueueUnavailableError,
    BookProcessingSkippedError,
    getBookMimeType,
    createOriginalUploadKey,
    isBookReady,
    InvalidBookFileError,
    MissingBookFileError,
    RETRYABLE_BOOK_STATUSES,
} from "../src";

test("book MIME types and original upload keys are stable", () => {
    assert.equal(getBookMimeType("pdf"), "application/pdf");
    assert.equal(getBookMimeType("epub"), "application/epub+zip");
    assert.equal(
        createOriginalUploadKey("user-1", "book-1"),
        "users/user-1/books/book-1/original"
    );
});

test("book lifecycle helpers recognize readiness and retryable states", () => {
    assert.equal(
        isBookReady({
            processingStatus: "ready",
            collectionName: "collection",
        }),
        true
    );
    assert.equal(
        isBookReady({ processingStatus: "ready", collectionName: null }),
        false
    );
    assert.equal(
        isBookReady({
            processingStatus: "processing",
            collectionName: "collection",
        }),
        false
    );
    assert.deepEqual(RETRYABLE_BOOK_STATUSES, ["failed", "queue_failed"]);
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
            new BookAccessDeniedError("book-1"),
            "BookAccessDeniedError",
            "Not authorized to access book book-1",
        ],
        [
            new BookNotRetryableError("book-1", "ready"),
            "BookNotRetryableError",
            "Book book-1 is not retryable in status ready",
        ],
        [
            new BookProcessingBusyError("book-1"),
            "BookProcessingBusyError",
            "Book processing is already in progress for book-1",
        ],
        [
            new BookLifecycleLockTimeoutError("book-1"),
            "BookLifecycleLockTimeoutError",
            "Book lifecycle lock timed out for book-1",
        ],
        [
            new BookLifecycleLockUnavailableError("book-1"),
            "BookLifecycleLockUnavailableError",
            "Book lifecycle lock unavailable for book-1",
        ],
        [
            new BookProcessingSkippedError("book-1", "ready"),
            "BookProcessingSkippedError",
            "Book processing skipped for book-1: ready",
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
