import {
    BadRequestException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpException,
    Inject,
    NotFoundException,
    Param,
    Post,
    Req,
    Res,
    UploadedFile,
    UseGuards,
    UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import {
    ApiBearerAuth,
    ApiBody,
    ApiConsumes,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import {
    createLogger,
    deleteFile,
    uploadFile,
    vectorStore,
} from "@reader/providers";
import { createBookCollectionName } from "@reader/processing";
import { eq, sql } from "drizzle-orm";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { UploadRateLimitGuard } from "../common/guards/rate-limit.guard";
import { DRIZZLE, type Database } from "../database/database.module";
import { Books } from "../db/schema";
import { bookSearchChunkStore } from "../services/BookSearchChunkStore";
import { hybridBookSearchService } from "../services/HybridBookSearchService";
import { handleBookProcessingEnqueue } from "../services/BookProcessingEnqueueService";
import { createOriginalUploadKey } from "../utils/uploadKeys";
import { validateBookUpload } from "../utils/validateBookUpload";
import { handleGetBookFile } from "./book-file.handler";
import type { User } from "../types";

const log = createLogger("books");

@ApiTags("Books")
@ApiBearerAuth()
@Controller("api/books")
@UseGuards(AuthGuard)
export class BooksController {
    constructor(@Inject(DRIZZLE) private readonly db: Database) {}

    @Post()
    @HttpCode(202)
    @UseGuards(UploadRateLimitGuard)
    @UseInterceptors(
        FileInterceptor("file", {
            limits: { fileSize: 80 * 1024 * 1024 },
        })
    )
    @ApiOperation({
        summary: "Upload and process EPUB file",
        description:
            "Uploads an EPUB file, creates embeddings, and stores in ChromaDB",
    })
    @ApiConsumes("multipart/form-data")
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                file: {
                    type: "string",
                    format: "binary",
                    description: "EPUB file to upload (max 80MB)",
                },
            },
        },
    })
    @ApiResponse({
        status: 200,
        description: "File successfully uploaded and processed",
    })
    @ApiResponse({ status: 400, description: "Bad request" })
    @ApiResponse({ status: 401, description: "Authentication failed" })
    @ApiResponse({ status: 413, description: "Payload too large" })
    async uploadBook(
        @CurrentUser() user: User,
        @UploadedFile() file?: Express.Multer.File
    ) {
        const requestStart = Date.now();
        log.info("Book upload request received", {
            userId: user.id,
            fileName: file?.originalname,
            mimeType: file?.mimetype,
        });
        try {
            if (!file) {
                log.warn("Book upload rejected: no file");
                throw new BadRequestException({ error: "No file uploaded" });
            }
            const fileBuffer = file.buffer;
            let fileType: "pdf" | "epub";
            try {
                fileType = await validateBookUpload(fileBuffer);
            } catch (error) {
                log.warn("Book upload rejected: unsupported file type", {
                    mimeType: file.mimetype,
                    userId: user.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw new BadRequestException({
                    error: "Invalid PDF or EPUB file",
                });
            }
            const mimeType =
                fileType === "pdf" ? "application/pdf" : "application/epub+zip";
            const bookId = randomUUID();
            const fileKey = createOriginalUploadKey(user.id, bookId);

            log.info("Uploading file to storage", {
                userId: user.id,
                fileKey,
                mimeType,
            });
            await uploadFile(fileKey, fileBuffer);
            log.info("File uploaded to storage", {
                userId: user.id,
                fileKey,
            });
            const [book] = await this.db
                .insert(Books)
                .values({
                    id: bookId,
                    title: file.originalname,
                    userId: user.id,
                    fileKey,
                    fileType,
                    processingStatus: "processing",
                    processingError: null,
                })
                .returning();
            log.info("Book record created", {
                bookId: book.id,
                userId: user.id,
                fileKey,
                fileType,
            });

            try {
                await handleBookProcessingEnqueue({
                    bookId: book.id,
                    userId: book.userId,
                    fileKey: book.fileKey,
                    fileType,
                });
            } catch (error) {
                log.error("Book processing enqueue failed", {
                    bookId: book.id,
                    error:
                        error instanceof Error ? error.message : String(error),
                });
                throw new HttpException(
                    { error: "Book processing queue is unavailable" },
                    503
                );
            }

            const [queuedBook] = await this.db
                .select()
                .from(Books)
                .where(eq(Books.id, book.id));

            const duration = Date.now() - requestStart;
            log.info("Book upload accepted", {
                bookId: book.id,
                durationMs: duration,
                fileKey,
            });
            return {
                message: "File upload accepted for processing",
                book: queuedBook ?? book,
                processStatus: "processing",
                fileType: mimeType,
            };
        } catch (e) {
            if (e instanceof HttpException) throw e;
            const duration = Date.now() - requestStart;
            log.error("Book upload failed", {
                userId: user.id,
                durationMs: duration,
                error: e instanceof Error ? e.message : String(e),
            });
            throw new HttpException({ error: "Upload failed" }, 500);
        }
    }

    @Get()
    @ApiOperation({
        summary: "Get all books uploaded by user",
        description: "Get all books uploaded by the user",
    })
    @ApiResponse({ status: 200, description: "Books successfully fetched" })
    @ApiResponse({ status: 401, description: "Authentication failed" })
    async listBooks(@CurrentUser() user: User) {
        const booksList = await this.db
            .select()
            .from(Books)
            .where(eq(Books.userId, user.id));

        return { books: booksList };
    }

    @Post(":id/retry")
    @HttpCode(202)
    async retryBook(@Param("id") id: string, @CurrentUser() user: User) {
        const [book] = await this.db
            .select()
            .from(Books)
            .where(eq(Books.id, id));
        if (!book || book.userId !== user.id) {
            throw new NotFoundException({ error: "Book was not found" });
        }
        if (
            !book.fileType ||
            !["queue_failed", "failed"].includes(book.processingStatus)
        ) {
            throw new HttpException({ error: "Book is not retryable" }, 409);
        }
        await this.db
            .update(Books)
            .set({
                processingStatus: "processing",
                processingError: null,
            })
            .where(eq(Books.id, book.id));
        try {
            await handleBookProcessingEnqueue({
                bookId: book.id,
                userId: book.userId,
                fileKey: book.fileKey,
                fileType: book.fileType,
            });
        } catch {
            throw new HttpException(
                { error: "Book processing queue is unavailable" },
                503
            );
        }
        return { bookId: book.id, status: "processing" };
    }

    @Get(":id/status")
    async getBookStatus(@Param("id") id: string, @CurrentUser() user: User) {
        try {
            const [book] = await this.db
                .select()
                .from(Books)
                .where(eq(Books.id, id));

            if (!book) {
                throw new NotFoundException({ error: "Book was not found" });
            }

            if (book.userId !== user.id) {
                throw new HttpException({ error: "Not authorized" }, 403);
            }

            return {
                bookId: book.id,
                fileType: book.fileType,
                ready:
                    book.processingStatus === "ready" &&
                    Boolean(book.collectionName),
                status: book.processingStatus,
                error: book.processingError,
            };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            console.error("Error fetching book processing status", error);
            throw new HttpException({ error: "Internal server error" }, 500);
        }
    }

    @Get(":id")
    @ApiOperation({ summary: "Get book by id", description: "Get book by id" })
    @ApiResponse({ status: 200, description: "Book successfully fetched" })
    @ApiResponse({ status: 401, description: "Authentication failed" })
    @ApiResponse({ status: 500, description: "Internal server error" })
    getBookFile(@Req() req: Request, @Res() res: Response) {
        void handleGetBookFile(req, res);
    }

    @Delete(":id")
    @HttpCode(204)
    async deleteBook(@Param("id") id: string, @CurrentUser() user: User) {
        const bookId = id;
        log.info("Book delete request received", { bookId, userId: user.id });

        try {
            const [book] = await this.db
                .select()
                .from(Books)
                .where(eq(Books.id, bookId));
            if (!book) {
                log.warn("Book delete failed: not found", { bookId });
                throw new NotFoundException({ error: "Book was not found" });
            }
            if (book.userId !== user.id) {
                log.warn("Book delete failed: unauthorized", {
                    bookId,
                    userId: user.id,
                    ownerId: book.userId,
                });
                throw new HttpException({ error: "Not authorized" }, 403);
            }
            await this.db
                .update(Books)
                .set({ processingStatus: "deleting" })
                .where(eq(Books.id, bookId));

            const [remaining] = await this.db
                .select({ count: sql`count(*)`.mapWith(Number) })
                .from(Books)
                .where(eq(Books.fileKey, book.fileKey));
            if (remaining.count <= 1) {
                log.info("Deleting orphaned file and collection", {
                    fileKey: book.fileKey,
                    collectionName: book.collectionName,
                });
                await deleteFile(book.fileKey);
            } else {
                log.debug("Skipping cleanup, file still referenced", {
                    fileKey: book.fileKey,
                    remainingCount: remaining.count,
                });
            }

            const collectionName =
                book.collectionName ?? createBookCollectionName(book.id);
            await vectorStore.deleteCollection(collectionName);
            await bookSearchChunkStore.deleteCollectionChunks(collectionName);
            hybridBookSearchService.clearCollectionCache(collectionName);

            await this.db.delete(Books).where(eq(Books.id, bookId));
            log.info("Book record deleted after cleanup", { bookId });

            log.info("Book delete successful", { bookId });
        } catch (e) {
            if (e instanceof HttpException) throw e;
            log.error("Book delete failed", {
                bookId,
                error: e instanceof Error ? e.message : String(e),
            });
            throw new HttpException(
                { error: "Failed to delete the file" },
                500
            );
        }
    }
}
