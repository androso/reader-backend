import {
    BadRequestException,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpException,
    Inject,
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
import { createLogger } from "@reader/providers";
import type {
    DeleteOwnedBook,
    GetOwnedBookFile,
    GetBookStatus,
    ListOwnedBooks,
    RetryBookProcessing,
    UploadBook,
} from "@reader/application";
import {
    BookAccessDeniedError,
    BookLifecycleLockUnavailableError,
    BookNotFoundError,
    BookNotRetryableError,
    BookProcessingBusyError,
    BookProcessingQueueUnavailableError,
    InvalidBookFileError,
    MissingBookFileError,
} from "@reader/domain";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import { UploadRateLimitGuard } from "../common/guards/rate-limit.guard";
import {
    DELETE_OWNED_BOOK,
    GET_OWNED_BOOK_FILE,
    GET_BOOK_STATUS,
    LIST_OWNED_BOOKS,
    RETRY_BOOK_PROCESSING,
    UPLOAD_BOOK,
} from "./books.tokens";
import type { User } from "../types";

const log = createLogger("books");

@ApiTags("Books")
@ApiBearerAuth()
@Controller("api/books")
@UseGuards(AuthGuard)
export class BooksController {
    constructor(
        @Inject(GET_OWNED_BOOK_FILE)
        private readonly getOwnedBookFileUseCase: GetOwnedBookFile,
        @Inject(UPLOAD_BOOK) private readonly uploadBookUseCase: UploadBook,
        @Inject(LIST_OWNED_BOOKS)
        private readonly listOwnedBooksUseCase: ListOwnedBooks,
        @Inject(GET_BOOK_STATUS)
        private readonly getBookStatusUseCase: GetBookStatus,
        @Inject(RETRY_BOOK_PROCESSING)
        private readonly retryBookProcessingUseCase: RetryBookProcessing,
        @Inject(DELETE_OWNED_BOOK)
        private readonly deleteOwnedBookUseCase: DeleteOwnedBook
    ) {}

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
            const result = await this.uploadBookUseCase.execute({
                userId: user.id,
                file: file
                    ? {
                          originalName: file.originalname,
                          buffer: file.buffer,
                      }
                    : undefined,
            });
            const duration = Date.now() - requestStart;
            log.info("Book upload accepted", {
                bookId: result.book.id,
                durationMs: duration,
                fileKey: result.book.fileKey,
            });
            return {
                message: "File upload accepted for processing",
                book: result.book,
                processStatus: "processing",
                fileType: result.mimeType,
            };
        } catch (e) {
            if (e instanceof MissingBookFileError) {
                log.warn("Book upload rejected: no file");
                throw new BadRequestException({ error: "No file uploaded" });
            }
            if (e instanceof InvalidBookFileError) {
                log.warn("Book upload rejected: unsupported file type", {
                    mimeType: file?.mimetype,
                    userId: user.id,
                    error: e.message,
                });
                throw new BadRequestException({
                    error: "Invalid PDF or EPUB file",
                });
            }
            if (e instanceof BookProcessingQueueUnavailableError) {
                throw new HttpException(
                    { error: "Book processing queue is unavailable" },
                    503
                );
            }
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
        return this.listOwnedBooksUseCase.execute({ userId: user.id });
    }

    @Post(":id/retry")
    @HttpCode(202)
    @ApiOperation({ summary: "Retry a failed book's processing job" })
    @ApiResponse({ status: 202, description: "Processing retry accepted" })
    @ApiResponse({ status: 404, description: "Book was not found" })
    @ApiResponse({ status: 409, description: "Book is not retryable or busy" })
    @ApiResponse({ status: 503, description: "Processing queue unavailable" })
    async retryBook(@Param("id") id: string, @CurrentUser() user: User) {
        try {
            return await this.retryBookProcessingUseCase.execute({
                bookId: id,
                userId: user.id,
            });
        } catch (error) {
            if (error instanceof BookNotFoundError) {
                throw new HttpException({ error: "Book was not found" }, 404);
            }
            if (error instanceof BookNotRetryableError) {
                throw new HttpException(
                    { error: "Book is not retryable" },
                    409
                );
            }
            if (error instanceof BookProcessingBusyError) {
                throw new HttpException(
                    { error: "Book processing is already in progress" },
                    409
                );
            }
            if (
                error instanceof BookProcessingQueueUnavailableError ||
                error instanceof BookLifecycleLockUnavailableError
            ) {
                throw new HttpException(
                    { error: "Book processing queue is unavailable" },
                    503
                );
            }
            throw new HttpException({ error: "Internal server error" }, 500);
        }
    }

    @Get(":id/status")
    @ApiOperation({ summary: "Get book processing status" })
    @ApiResponse({
        status: 200,
        description: "Book status successfully fetched",
    })
    @ApiResponse({ status: 403, description: "Not authorized" })
    @ApiResponse({ status: 404, description: "Book was not found" })
    @ApiResponse({ status: 500, description: "Internal server error" })
    async getBookStatus(@Param("id") id: string, @CurrentUser() user: User) {
        try {
            return await this.getBookStatusUseCase.execute({
                bookId: id,
                userId: user.id,
            });
        } catch (error) {
            if (error instanceof BookNotFoundError) {
                throw new HttpException({ error: "Book was not found" }, 404);
            }
            if (error instanceof BookAccessDeniedError) {
                throw new HttpException({ error: "Not authorized" }, 403);
            }
            log.error("Error fetching book processing status", {
                bookId: id,
                error: error instanceof Error ? error.message : String(error),
            });
            throw new HttpException({ error: "Internal server error" }, 500);
        }
    }

    @Get(":id")
    @ApiOperation({ summary: "Get book by id", description: "Get book by id" })
    @ApiResponse({ status: 200, description: "Book successfully fetched" })
    @ApiResponse({ status: 401, description: "Authentication failed" })
    @ApiResponse({ status: 500, description: "Internal server error" })
    async getBookFile(@Req() req: Request, @Res() res: Response) {
        try {
            const file = await this.getOwnedBookFileUseCase.execute({
                bookId: req.params.id as string,
                userId: req.user.id,
            });
            res.setHeader("Cache-Control", "private");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.type(
                file.fileType === "pdf"
                    ? "application/pdf"
                    : file.fileType === "epub"
                      ? "application/epub+zip"
                      : "application/octet-stream"
            );
            res.send(file.bytes);
        } catch (error) {
            if (error instanceof BookNotFoundError) {
                res.status(404).json({ error: "Book was not found" });
                return;
            }
            if (error instanceof BookAccessDeniedError) {
                res.status(403).json({ error: "Not authorized" });
                return;
            }
            console.error("Error fetching file", error);
            res.status(500).json({ error: "Internal server error" });
        }
    }

    @Delete(":id")
    @HttpCode(204)
    @ApiOperation({ summary: "Delete a book and its unshared artifacts" })
    @ApiResponse({ status: 204, description: "Book deleted" })
    @ApiResponse({ status: 403, description: "Not authorized" })
    @ApiResponse({ status: 404, description: "Book was not found" })
    @ApiResponse({ status: 500, description: "Failed to delete the file" })
    async deleteBook(@Param("id") id: string, @CurrentUser() user: User) {
        const bookId = id;
        log.info("Book delete request received", { bookId, userId: user.id });

        try {
            await this.deleteOwnedBookUseCase.execute({
                bookId,
                userId: user.id,
            });
            log.info("Book delete successful", { bookId });
        } catch (error) {
            if (error instanceof BookNotFoundError) {
                throw new HttpException({ error: "Book was not found" }, 404);
            }
            if (error instanceof BookAccessDeniedError) {
                throw new HttpException({ error: "Not authorized" }, 403);
            }
            log.error("Book delete failed", {
                bookId,
                error: error instanceof Error ? error.message : String(error),
            });
            throw new HttpException(
                { error: "Failed to delete the file" },
                500
            );
        }
    }
}
