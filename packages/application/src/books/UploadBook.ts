import {
    BookProcessingQueueUnavailableError,
    createOriginalUploadKey,
    getBookMimeType,
    InvalidBookFileError,
    MissingBookFileError,
    type Book,
    type BookFileType,
    type BookProcessingRequest,
} from "@reader/domain";
import { noopLogger } from "./ports";
import type {
    BookFileStorage,
    BookFileValidator,
    BookProcessingScheduler,
    BookRepository,
    IdGenerator,
    Logger,
    UploadBookFile,
} from "./ports";

export interface UploadBookDependencies {
    ids: IdGenerator;
    validator: BookFileValidator;
    storage: Pick<BookFileStorage, "save">;
    books: BookRepository;
    scheduler: BookProcessingScheduler;
    logger?: Logger;
}

export interface UploadBookRequest {
    userId: string;
    file?: UploadBookFile;
}

export interface UploadBookResult {
    book: Book;
    fileType: BookFileType;
    mimeType: string;
}

export class UploadBook {
    constructor(private readonly deps: UploadBookDependencies) {}

    async execute({
        userId,
        file,
    }: UploadBookRequest): Promise<UploadBookResult> {
        const logger = this.deps.logger ?? noopLogger;
        if (!file) throw new MissingBookFileError();

        let fileType: BookFileType;
        try {
            fileType = await this.deps.validator.detectFileType(file.buffer);
        } catch (error) {
            throw new InvalidBookFileError(
                error instanceof Error ? error.message : String(error)
            );
        }
        const mimeType = getBookMimeType(fileType);
        const id = this.deps.ids.next();
        const fileKey = createOriginalUploadKey(userId, id);

        logger.info("Uploading file to storage", { userId, fileKey, mimeType });
        await this.deps.storage.save(fileKey, file.buffer);
        logger.info("File uploaded to storage", { userId, fileKey });

        const book = await this.deps.books.create({
            id,
            title: file.originalName,
            userId,
            fileKey,
            fileType,
            processingStatus: "processing",
            processingError: null,
        });
        logger.info("Book record created", {
            bookId: book.id,
            userId: book.userId,
            fileKey,
            fileType,
        });

        const request: BookProcessingRequest = {
            bookId: book.id,
            userId: book.userId,
            fileKey: book.fileKey,
            fileType,
        };
        try {
            await this.deps.scheduler.schedule(request);
        } catch (error) {
            const queueError =
                error instanceof BookProcessingQueueUnavailableError
                    ? error
                    : new BookProcessingQueueUnavailableError(
                          error instanceof Error ? error.message : String(error)
                      );
            logger.error("Book processing enqueue failed", {
                bookId: book.id,
                error: queueError.message,
            });
            throw queueError;
        }

        const queued = await this.deps.books.findById(book.id);
        return { book: queued ?? book, fileType, mimeType };
    }
}
