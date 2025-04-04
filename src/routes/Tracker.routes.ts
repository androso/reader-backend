import { Request, Response, Router } from "express";
import { authenticate } from "../middleware/auth";
import { Progress } from "../db/schema";
import { Books } from "../db/schema";
import { db } from "../db";
import { and, eq } from "drizzle-orm";

interface TrackerObjetc {
    user_id: string;
    book_id: string;
    indent: string;
}
const router = Router();

router.get("/progress", async (req: Request, res: Response) => {
    const [progress] = await db.select().from(Progress);
    res.status(200).json({ data: progress });
});

router.get(
    "/:rid/progress",
    authenticate,
    async (req: Request, res: Response) => {
        try {
            const user_id = req.user.id;
            const book_id = req.params.rid;

            // First get the book to ensure it exists
            const [book] = await db
                .select()
                .from(Books)
                .where(eq(Books.fileKey, book_id));

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

            console.log(progress.progressPosition);
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
            const file_key = req.params.rid;
            const { progress_block, progress_chapter } = req.body;

            if (!progress_block) {
                res.status(400).json({ message: "Progress Block is required" });
                return;
            }

            // Get book by file key
            const [book] = await db
                .select()
                .from(Books)
                .where(eq(Books.fileKey, file_key));

            if (!book) {
                res.status(404).json({ message: "Book not found" });
                return;
            }

            // Check existing progress using book.fileKey
            const existingProgress = await db
                .select()
                .from(Progress)
                .where(
                    and(
                        eq(Progress.userId, user_id),
                        eq(Progress.bookId, book.id)
                    )
                );

            let progress;
            if (existingProgress.length > 0) {
                [progress] = await db
                    .update(Progress)
                    .set({
                        progressPosition: progress_block,
                        progressChapter: progress_chapter,
                        updatedAt: new Date(),
                    })
                    .where(
                        and(
                            eq(Progress.userId, user_id),
                            eq(Progress.bookId, book.id)
                        )
                    )
                    .returning();
            } else {
                [progress] = await db
                    .insert(Progress)
                    .values({
                        userId: user_id,
                        bookId: book.fileKey,
                        progressPosition: progress_block,
                        progressChapter: progress_chapter,
                        createdAt: new Date(),
                    })
                    .returning();
            }
            console.log("data", progress);
            res.status(201).json({ message: "Progress saved", data: progress });
        } catch (error) {
            console.error("Progress can't be tracked", error);
            res.status(500).json({ message: "Progress wasn't saved" });
        }
    }
);

export default router;
