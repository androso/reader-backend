import {
    BookAccessDeniedError,
    BookNotFoundError,
    isBookReady,
    type BookFileType,
} from "@reader/domain";
import type { BookReadRepository } from "./ports";

export interface GetBookStatusDependencies {
    repository: Pick<BookReadRepository, "findById">;
}

export interface BookStatusResult {
    bookId: string;
    fileType: BookFileType | null;
    ready: boolean;
    status: string;
    error: string | null;
}

export class GetBookStatus {
    constructor(private readonly deps: GetBookStatusDependencies) {}

    async execute({
        bookId,
        userId,
    }: {
        bookId: string;
        userId: string;
    }): Promise<BookStatusResult> {
        const book = await this.deps.repository.findById(bookId);
        if (!book) throw new BookNotFoundError(bookId);
        if (book.userId !== userId) throw new BookAccessDeniedError(bookId);

        return {
            bookId: book.id,
            fileType: book.fileType,
            ready: isBookReady(book),
            status: book.processingStatus,
            error: book.processingError,
        };
    }
}
