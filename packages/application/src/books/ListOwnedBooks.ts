import type { Book } from "@reader/domain";
import type { BookReadRepository } from "./ports";

export interface ListOwnedBooksDependencies {
    repository: Pick<BookReadRepository, "listByOwner">;
}

export class ListOwnedBooks {
    constructor(private readonly deps: ListOwnedBooksDependencies) {}

    async execute({ userId }: { userId: string }): Promise<{ books: Book[] }> {
        return { books: await this.deps.repository.listByOwner(userId) };
    }
}
