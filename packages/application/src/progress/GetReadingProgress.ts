import { BookNotFoundError } from "@reader/domain";
import type { ReadingProgressRepository } from "./ports";
import type { OwnedBookLookup } from "../rag/ports";

export interface GetReadingProgressDependencies {
    books: Pick<OwnedBookLookup, "findOwned">;
    progress: Pick<ReadingProgressRepository, "find">;
}

export class GetReadingProgress {
    constructor(private readonly deps: GetReadingProgressDependencies) {}

    async execute({ userId, bookId }: { userId: string; bookId: string }) {
        const book = await this.deps.books.findOwned({ userId, bookId });
        if (!book) throw new BookNotFoundError(bookId);

        return this.deps.progress.find({ userId, bookId: book.id });
    }
}
