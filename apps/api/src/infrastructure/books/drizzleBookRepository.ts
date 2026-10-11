import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import type {
    BookDeletionRepository,
    BookProcessingRepository,
    BookQueueStateRepository,
    BookReadRepository,
    BookRepository,
    BookRetryStateRepository,
    BookArtifactReferences,
} from "@reader/application";
import type { Book, BookProcessingRecord, NewBook } from "@reader/domain";
import { createLogger } from "@reader/providers";
import type { Database } from "../../database/database.module";
import { Books } from "../../db/schema";

type BookRowMatchesDomain = typeof Books.$inferSelect extends Book
    ? true
    : false;
type DomainBookMatchesRow = Book extends typeof Books.$inferSelect
    ? true
    : false;
const bookRowTypeChecks: [BookRowMatchesDomain, DomainBookMatchesRow] = [
    true,
    true,
];
void bookRowTypeChecks;

const serviceLog = createLogger("BookProcessingService");
const enqueueLog = createLogger("BookProcessingEnqueueService");

export type DrizzleBookRepository = BookRepository &
    BookProcessingRepository &
    BookQueueStateRepository &
    BookReadRepository &
    BookRetryStateRepository &
    BookDeletionRepository &
    BookArtifactReferences;

export const createDrizzleBookRepository = (
    database: Database
): DrizzleBookRepository => ({
    async create(book: NewBook) {
        const [row] = await database.insert(Books).values(book).returning();
        return row;
    },

    async findById(bookId) {
        const [book] = await database
            .select()
            .from(Books)
            .where(eq(Books.id, bookId));
        return book ?? null;
    },

    async findOwned(bookId, userId) {
        const [book] = await database
            .select()
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));
        return book ?? null;
    },

    async listByOwner(userId) {
        return database.select().from(Books).where(eq(Books.userId, userId));
    },

    async findBookForProcessing(
        bookId,
        userId
    ): Promise<BookProcessingRecord | null> {
        serviceLog.debug("Finding book for processing", { bookId, userId });
        const [book] = await database
            .select()
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));
        if (!book) {
            serviceLog.warn("Book not found for processing", {
                bookId,
                userId,
            });
        } else {
            serviceLog.debug("Book found for processing", {
                bookId,
                userId,
                fileKey: book.fileKey,
                fileType: book.fileType,
                processingStatus: book.processingStatus,
            });
        }
        return book ?? null;
    },

    async markReady(bookId, userId, collectionName) {
        serviceLog.info("Marking book as ready", {
            bookId,
            userId,
            collectionName,
        });
        const updated = await database
            .update(Books)
            .set({
                collectionName,
                processingStatus: "ready",
                processingError: null,
            })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, "processing")
                )
            )
            .returning({ id: Books.id });
        serviceLog.info("Book ready publication attempted", {
            bookId,
            userId,
            collectionName,
            published: updated.length === 1,
        });
        return updated.length === 1;
    },

    async markFailed(bookId, userId, error) {
        serviceLog.error("Marking book as failed", { bookId, userId, error });
        const updated = await database
            .update(Books)
            .set({
                processingStatus: "failed",
                processingError: error,
            })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, "processing")
                )
            )
            .returning({ id: Books.id });
        serviceLog.error("Book failure publication attempted", {
            bookId,
            userId,
            error,
            updated: updated.length === 1,
        });
        return updated.length === 1;
    },

    async markQueueFailed(bookId, userId, error) {
        enqueueLog.error("Marking book queue failed", {
            bookId,
            userId,
            error,
        });
        const updated = await database
            .update(Books)
            .set({
                processingStatus: "queue_failed",
                processingError: `Book processing queue unavailable: ${error}`,
            })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, "processing")
                )
            )
            .returning({ id: Books.id });
        enqueueLog.error("Book queue failure publication attempted", {
            bookId,
            userId,
            error,
            updated: updated.length === 1,
        });
        return updated.length === 1;
    },

    async claimRetry(bookId, userId, expectedStatus) {
        const [book] = await database
            .update(Books)
            .set({ processingStatus: "processing", processingError: null })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, expectedStatus),
                    isNotNull(Books.fileType)
                )
            )
            .returning();
        return book ?? null;
    },

    async restoreRetryable(bookId, userId, status, error) {
        const updated = await database
            .update(Books)
            .set({ processingStatus: status, processingError: error })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, "processing")
                )
            )
            .returning({ id: Books.id });
        return updated.length === 1;
    },

    async markDeleting(bookId, userId) {
        const updated = await database
            .update(Books)
            .set({ processingStatus: "deleting" })
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    inArray(Books.processingStatus, [
                        "processing",
                        "ready",
                        "failed",
                        "queue_failed",
                        "deleting",
                    ])
                )
            )
            .returning({ id: Books.id });
        return updated.length === 1;
    },

    async deleteDeletingRow(bookId, userId) {
        const deleted = await database
            .delete(Books)
            .where(
                and(
                    eq(Books.id, bookId),
                    eq(Books.userId, userId),
                    eq(Books.processingStatus, "deleting")
                )
            )
            .returning({ id: Books.id });
        return deleted.length === 1;
    },

    async countLiveFileReferences(fileKey, excludingBookId) {
        const [result] = await database
            .select({ count: sql<number>`count(*)`.mapWith(Number) })
            .from(Books)
            .where(
                and(
                    eq(Books.fileKey, fileKey),
                    ne(Books.id, excludingBookId),
                    ne(Books.processingStatus, "deleting")
                )
            );
        return result?.count ?? 0;
    },

    async countLiveCollectionReferences(collectionName, excludingBookId) {
        const [result] = await database
            .select({ count: sql<number>`count(*)`.mapWith(Number) })
            .from(Books)
            .where(
                and(
                    eq(Books.collectionName, collectionName),
                    ne(Books.id, excludingBookId),
                    ne(Books.processingStatus, "deleting")
                )
            );
        return result?.count ?? 0;
    },
});
