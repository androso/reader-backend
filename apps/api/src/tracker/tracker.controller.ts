import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpException,
    Inject,
    NotFoundException,
    Param,
    Post,
    UseGuards,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { DRIZZLE, type Database } from "../database/database.module";
import { Books, Progress } from "../db/schema";
import type { User } from "../types";

@Controller("api")
@UseGuards(AuthGuard)
export class TrackerController {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    @Get(":rid/progress")
    async getProgress(@Param("rid") rid: string, @CurrentUser() user: User) {
        try {
            const user_id = user.id;
            const book_id = rid;

            const [book] = await this.db
                .select()
                .from(Books)
                .where(and(eq(Books.id, book_id), eq(Books.userId, user_id)));

            if (!book) {
                throw new NotFoundException({ message: "Book not found" });
            }

            const [progress] = await this.db
                .select()
                .from(Progress)
                .where(
                    and(
                        eq(Progress.userId, user_id),
                        eq(Progress.bookId, book.id)
                    )
                );

            if (!progress) {
                return { progressPosition: null };
            }
            return {
                progressPosition: progress.progressPosition,
                progressChapter: progress.progressChapter,
            };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Error fetching progress:", error);
            throw new HttpException({ message: "Internal server error" }, 500);
        }
    }

    @Post(":rid/progress")
    @HttpCode(201)
    async saveProgress(
        @Param("rid") rid: string,
        @CurrentUser() user: User,
        @Body() body: { progress_block?: string; progress_chapter?: string }
    ) {
        try {
            const user_id = user.id;
            const book_id = rid;
            const { progress_block, progress_chapter } = body;

            if (!progress_block) {
                throw new BadRequestException({
                    message: "Progress Block is required",
                });
            }

            const [book] = await this.db
                .select()
                .from(Books)
                .where(and(eq(Books.id, book_id), eq(Books.userId, user_id)));

            if (!book) {
                throw new NotFoundException({ message: "Book not found" });
            }

            const [progress] = await this.db
                .insert(Progress)
                .values({
                    userId: user_id,
                    bookId: book.id,
                    progressPosition: progress_block,
                    progressChapter: progress_chapter as string,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                })
                .onConflictDoUpdate({
                    target: [Progress.userId, Progress.bookId],
                    set: {
                        progressPosition: progress_block,
                        progressChapter: progress_chapter as string,
                        updatedAt: new Date(),
                    },
                })
                .returning();
            return { message: "Progress saved", data: progress };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Progress can't be tracked", error);
            throw new HttpException({ message: "Progress wasn't saved" }, 500);
        }
    }
}
