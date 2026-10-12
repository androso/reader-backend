import type { ReadingProgress } from "@reader/domain";

export interface ReadingProgressRepository {
    find(input: {
        userId: string;
        bookId: string;
    }): Promise<ReadingProgress | null>;
    saveForLiveOwnedBook(input: {
        userId: string;
        bookId: string;
        position: string;
        chapter: string | null | undefined;
        now: Date;
    }): Promise<ReadingProgress | null>;
}
