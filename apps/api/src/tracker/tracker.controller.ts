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
import { GetReadingProgress, SaveReadingProgress } from "@reader/application";
import { BookNotFoundError, ProgressValidationError } from "@reader/domain";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import type { User } from "../types";
import { GET_READING_PROGRESS, SAVE_READING_PROGRESS } from "./progress.tokens";

@Controller("api")
@UseGuards(AuthGuard)
export class TrackerController {
    constructor(
        @Inject(GET_READING_PROGRESS)
        private readonly getReadingProgress: GetReadingProgress,
        @Inject(SAVE_READING_PROGRESS)
        private readonly saveReadingProgress: SaveReadingProgress
    ) {}

    @Get(":rid/progress")
    async getProgress(@Param("rid") rid: string, @CurrentUser() user: User) {
        try {
            const progress = await this.getReadingProgress.execute({
                userId: user.id,
                bookId: rid,
            });
            if (!progress) {
                return { progressPosition: null };
            }
            return {
                progressPosition: progress.progressPosition,
                progressChapter: progress.progressChapter,
            };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            if (error instanceof BookNotFoundError) {
                throw new NotFoundException({ message: "Book not found" });
            }
            console.error("Error fetching progress:", error);
            throw new HttpException({ message: "Internal server error" }, 500);
        }
    }

    @Post(":rid/progress")
    @HttpCode(201)
    async saveProgress(
        @Param("rid") rid: string,
        @CurrentUser() user: User,
        @Body() body: unknown
    ) {
        try {
            const input =
                body !== null && typeof body === "object"
                    ? (body as Record<string, unknown>)
                    : {};
            const saved = await this.saveReadingProgress.execute({
                userId: user.id,
                bookId: rid,
                position: input.progress_block,
                ...("progress_chapter" in input
                    ? { chapter: input.progress_chapter }
                    : {}),
            });
            return { message: "Progress saved", data: saved };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            if (error instanceof ProgressValidationError) {
                throw new BadRequestException({ message: error.message });
            }
            if (error instanceof BookNotFoundError) {
                throw new NotFoundException({ message: "Book not found" });
            }
            console.error("Progress can't be tracked", error);
            throw new HttpException({ message: "Progress wasn't saved" }, 500);
        }
    }
}
