import { Request, Response, Router } from "express";
import { authenticate } from "../middleware/auth";
import { Books, Progress } from "../db/schema";
import { db } from "../db";
import { and, eq } from "drizzle-orm";

const router = Router();

router.get(
    "/:rid/progress",
    authenticate,
    async (req: Request, res: Response) => {
        try {
            const user_id = req.user.id;
            const book_id = req.params.rid;

            const [book] = await db
                .select()
                .from(Books)
                .where(and(eq(Books.id, book_id), eq(Books.userId, user_id)));

            if (!book) {
                res.status(404).json({ message: "Book not found" });
                return;
            }

            const [progress] = await db
                .select()
                .from(Progress)
                .where(
                    and(
                        eq(Progress.userId, user_id),
                        eq(Progress.bookId, book.id)
                    )
                );

            // If no progress exists, return initial state
            if (!progress) {
                res.status(200).json({
                    progressPosition: null,
                });
                return;
            }
            res.status(200).json({
                progressPosition: progress.progressPosition,
                progressChapter: progress.progressChapter,
            });
        } catch (error) {
            console.error("Error fetching progress:", error);
            res.status(500).json({ message: "Internal server error" });
        }
    }
);

router.post(
    "/:rid/progress",
    authenticate,
    async (req: Request, res: Response) => {
        try {
            const user_id = req.user.id;
            const book_id = req.params.rid;
            const { progress_block, progress_chapter } = req.body;

            if (!progress_block) {
                res.status(400).json({ message: "Progress Block is required" });
                return;
            }

            const [book] = await db
                .select()
                .from(Books)
                .where(and(eq(Books.id, book_id), eq(Books.userId, user_id)));

            if (!book) {
                res.status(404).json({ message: "Book not found" });
                return;
            }

            const [progress] = await db
                .insert(Progress)
                .values({
                    userId: user_id,
                    bookId: book.id,
                    progressPosition: progress_block,
                    progressChapter: progress_chapter,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: [Progress.userId, Progress.bookId],
                    set: {
                        progressPosition: progress_block,
                        progressChapter: progress_chapter,
                        updatedAt: new Date(),
                    },
                })
                .returning();
            res.status(201).json({ message: "Progress saved", data: progress });
        } catch (error) {
            console.error("Progress can't be tracked", error);
            res.status(500).json({ message: "Progress wasn't saved" });
        }
    }
);

export default router;
