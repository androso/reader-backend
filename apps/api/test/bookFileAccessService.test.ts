import assert from "node:assert/strict";
import test from "node:test";
import {
    getBookContentType,
    getOwnedBookFile,
    type BookFileAccessDependencies,
    type BookFileRecord,
} from "../src/services/BookFileAccessService";

const createDependencies = (
    book: BookFileRecord | null
): BookFileAccessDependencies & { storageCalls: string[] } => {
    const storageCalls: string[] = [];

    return {
        storageCalls,
        repository: {
            async findOwnedBook(bookId, userId) {
                if (!book) return null;
                return book.id === bookId && book.userId === userId
                    ? book
                    : null;
            },
        },
        storage: {
            async getFile(fileKey) {
                storageCalls.push(fileKey);
                return Buffer.from(`file:${fileKey}`);
            },
        },
    };
};

test("owned book file is fetched by stored file key", async () => {
    const dependencies = createDependencies({
        id: "book-1",
        userId: "user-1",
        fileKey: "epub-storage-key",
        fileType: "epub",
    });

    const result = await getOwnedBookFile("book-1", "user-1", dependencies);

    assert.equal(result.status, "found");
    assert.deepEqual(dependencies.storageCalls, ["epub-storage-key"]);
    if (result.status === "found") {
        assert.equal(result.fileBuffer.toString(), "file:epub-storage-key");
        assert.equal(result.contentType, "application/epub+zip");
    }
});

test("missing book returns not found without reading storage", async () => {
    const dependencies = createDependencies(null);

    const result = await getOwnedBookFile(
        "missing-book",
        "user-1",
        dependencies
    );

    assert.deepEqual(result, { status: "not_found" });
    assert.deepEqual(dependencies.storageCalls, []);
});

test("book owned by another user returns not found without reading storage", async () => {
    const dependencies = createDependencies({
        id: "book-1",
        userId: "owner-user",
        fileKey: "pdf-storage-key",
        fileType: "pdf",
    });

    const result = await getOwnedBookFile(
        "book-1",
        "requester-user",
        dependencies
    );

    assert.deepEqual(result, { status: "not_found" });
    assert.deepEqual(dependencies.storageCalls, []);
});

test("book content type is derived from the database file type", () => {
    assert.equal(getBookContentType("pdf"), "application/pdf");
    assert.equal(getBookContentType("epub"), "application/epub+zip");
    assert.equal(getBookContentType(null), "application/octet-stream");
});
