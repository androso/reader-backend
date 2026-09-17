import { Module } from "@nestjs/common";
import { DRIZZLE, type Database } from "../database/database.module";
import { BooksController } from "./books.controller";
import { BOOKS_PORTS, createBooksPorts } from "./books.ports";

@Module({
    controllers: [BooksController],
    providers: [
        {
            provide: BOOKS_PORTS,
            useFactory: (db: Database) => createBooksPorts(db),
            inject: [DRIZZLE],
        },
    ],
})
export class BooksModule {}
