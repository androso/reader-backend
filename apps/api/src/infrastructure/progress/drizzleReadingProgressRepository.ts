import { and, eq, ne } from "drizzle-orm";
import type { ReadingProgressRepository } from "@reader/application";
import type { ReadingProgress } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Books, Progress } from "../../db/schema";

export interface DrizzleReadingProgressRepositoryOptions {
    afterBookLock?: () => Promise<void>;
}

export const createDrizzleReadingProgressRepository = (
    database: Database,
    options: DrizzleReadingProgressRepositoryOptions = {}
): ReadingProgressRepository => ({
    async find({ userId, bookId }) {
        const [row] = await database
            .select()
            .from(Progress)
            .where(
                and(eq(Progress.userId, userId), eq(Progress.bookId, bookId))
            );
        return row ?? null;
    },

    async saveForLiveOwnedBook({
        userId,
        bookId,
        position,
        chapter,
        now,
    }): Promise<ReadingProgress | null> {
        return database.transaction(async (transaction) => {
            const [book] = await transaction
                .select({ id: Books.id })
                .from(Books)
                .where(
                    and(
                        eq(Books.id, bookId),
                        eq(Books.userId, userId),
                        ne(Books.processingStatus, "deleting")
                    )
                )
                .for("update");
            if (!book) return null;

            await options.afterBookLock?.();

            const conflictSet = {
                progressPosition: position,
                updatedAt: now,
                ...(chapter === undefined ? {} : { progressChapter: chapter }),
            };
            const [row] = await transaction
                .insert(Progress)
                .values({
                    userId,
                    bookId,
                    progressPosition: position,
                    progressChapter: chapter ?? null,
                    createdAt: now,
                    updatedAt: now,
                })
                .onConflictDoUpdate({
                    target: [Progress.userId, Progress.bookId],
                    set: conflictSet,
                })
                .returning();
            return row ?? null;
        });
    },
});
