import { Module } from "@nestjs/common";
import { createUploadBook } from "../infrastructure/books";
import { DRIZZLE, type Database } from "../database/database.module";
import { BooksController } from "./books.controller";
import { BOOKS_PORTS, createBooksPorts } from "./books.ports";
import { UPLOAD_BOOK } from "./books.tokens";

export const BOOKS_USE_CASE_PROVIDERS = [
    {
        provide: UPLOAD_BOOK,
        useFactory: (
            db: Database,
            ports: ReturnType<typeof createBooksPorts>
        ) => createUploadBook(db, ports),
        inject: [DRIZZLE, BOOKS_PORTS],
    },
];

@Module({
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
