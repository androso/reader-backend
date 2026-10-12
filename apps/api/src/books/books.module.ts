import { Module } from "@nestjs/common";
import { GetOwnedBookFile } from "@reader/application";
import { SessionModule } from "../auth/session.module";
import {
    createDeleteOwnedBook,
    createGetBookStatus,
    createListOwnedBooks,
    createRetryBookProcessing,
    createUploadBook,
} from "../infrastructure/books";
import { DRIZZLE, type Database } from "../database/database.module";
import { BooksController } from "./books.controller";
import { BOOKS_PORTS, createBooksPorts } from "./books.ports";
import {
    DELETE_OWNED_BOOK,
    GET_OWNED_BOOK_FILE,
    GET_BOOK_STATUS,
    LIST_OWNED_BOOKS,
    RETRY_BOOK_PROCESSING,
    UPLOAD_BOOK,
} from "./books.tokens";

export const BOOKS_USE_CASE_PROVIDERS = [
    {
        provide: GET_OWNED_BOOK_FILE,
        useFactory: (ports: ReturnType<typeof createBooksPorts>) =>
            new GetOwnedBookFile({
                books: {
                    findById: async (bookId) =>
                        (await ports.bookFile.findBookById(bookId)) ?? null,
                },
                storage: { getFile: ports.bookFile.getFile },
            }),
        inject: [BOOKS_PORTS],
    },
    {
        provide: UPLOAD_BOOK,
        useFactory: (
            db: Database,
            ports: ReturnType<typeof createBooksPorts>
        ) => createUploadBook(db, ports),
        inject: [DRIZZLE, BOOKS_PORTS],
    },
    {
        provide: LIST_OWNED_BOOKS,
        useFactory: (db: Database) => createListOwnedBooks(db),
        inject: [DRIZZLE],
    },
    {
        provide: GET_BOOK_STATUS,
        useFactory: (db: Database) => createGetBookStatus(db),
        inject: [DRIZZLE],
    },
    {
        provide: RETRY_BOOK_PROCESSING,
        useFactory: (db: Database) => createRetryBookProcessing(db),
        inject: [DRIZZLE],
    },
    {
        provide: DELETE_OWNED_BOOK,
        useFactory: (db: Database) => createDeleteOwnedBook(db),
        inject: [DRIZZLE],
    },
];

@Module({
    imports: [SessionModule],
    controllers: [BooksController],
    providers: [
        ...BOOKS_USE_CASE_PROVIDERS,
        {
            provide: BOOKS_PORTS,
            useFactory: (db: Database) => createBooksPorts(db),
            inject: [DRIZZLE],
        },
    ],
})
export class BooksModule {}
