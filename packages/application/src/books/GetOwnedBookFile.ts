import {
    BookAccessDeniedError,
    BookNotFoundError,
    type Book,
} from "@reader/domain";
import type { BookFileStorage } from "./ports";

export interface GetOwnedBookFileInput {
    bookId: string;
    userId: string;
}

export interface OwnedBookFile {
    bytes: Uint8Array;
    fileType: Book["fileType"];
}

type BookFileBook = Pick<Book, "id" | "userId" | "fileKey" | "fileType">;

export class GetOwnedBookFile {
    constructor(
        private readonly deps: {
            books: {
                findById(bookId: string): Promise<BookFileBook | null>;
            };
            storage: Pick<BookFileStorage, "getFile">;
        }
    ) {}

    async execute(input: GetOwnedBookFileInput): Promise<OwnedBookFile> {
        const book = await this.deps.books.findById(input.bookId);
        if (!book) throw new BookNotFoundError(input.bookId);
        if (book.userId !== input.userId) {
            throw new BookAccessDeniedError(input.bookId);
        }

        return {
            bytes: await this.deps.storage.getFile(book.fileKey),
            fileType: book.fileType,
        };
    }
}
