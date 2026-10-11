import { and, eq } from "drizzle-orm";
import type {
    BookProcessingRepository,
    BookQueueStateRepository,
    BookRepository,
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
    BookQueueStateRepository;

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

    async markReady(bookId, collectionName) {
        serviceLog.info("Marking book as ready", { bookId, collectionName });
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
                    eq(Books.processingStatus, "processing")
                )
            )
            .returning({ id: Books.id });
        serviceLog.info("Book marked as ready", { bookId, collectionName });
        return updated.length === 1;
    },

    async markFailed(bookId, error) {
        serviceLog.error("Marking book as failed", { bookId, error });
        await database
            .update(Books)
            .set({
                processingStatus: "failed",
                processingError: error,
            })
            .where(eq(Books.id, bookId));
        serviceLog.error("Book marked as failed", { bookId, error });
    },

    async markQueueFailed(bookId, error) {
        enqueueLog.error("Marking book queue failed", { bookId, error });
        await database
            .update(Books)
            .set({
                processingStatus: "queue_failed",
                processingError: `Book processing queue unavailable: ${error}`,
            })
            .where(eq(Books.id, bookId));
        enqueueLog.error("Book queue marked failed", { bookId, error });
    },
});
