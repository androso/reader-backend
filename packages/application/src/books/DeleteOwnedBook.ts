import { BookAccessDeniedError, BookNotFoundError } from "@reader/domain";
import { noopLogger } from "./ports";
import type {
    BookArtifactCleanup,
    BookArtifactReferences,
    BookDeletionRepository,
    BookLifecycleLock,
    BookQueueControl,
    BookReadRepository,
    Logger,
} from "./ports";

export interface DeleteOwnedBookDependencies {
    reads: Pick<BookReadRepository, "findById" | "findOwned">;
    deletion: BookDeletionRepository;
    references: BookArtifactReferences;
    cleanup: BookArtifactCleanup;
    queue: Pick<BookQueueControl, "removePending">;
    lock: BookLifecycleLock;
    logger?: Logger;
}

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export class DeleteOwnedBook {
    private readonly logger: Logger;

    constructor(private readonly deps: DeleteOwnedBookDependencies) {
        this.logger = deps.logger ?? noopLogger;
    }

    async execute({
        bookId,
        userId,
    }: {
        bookId: string;
        userId: string;
    }): Promise<void> {
        const book = await this.deps.reads.findById(bookId);
        if (!book) throw new BookNotFoundError(bookId);
        if (book.userId !== userId) throw new BookAccessDeniedError(bookId);

        const marked = await this.deps.deletion.markDeleting(bookId, userId);
        if (!marked) return;

        try {
            await this.deps.queue.removePending(bookId);
        } catch (error) {
            this.logger.warn("Unable to remove pending book processing job", {
                bookId,
                error: errorMessage(error),
            });
        }

        await this.deps.lock.withLock(bookId, async () => {
            const deletingBook = await this.deps.reads.findOwned(
                bookId,
                userId
            );
            if (!deletingBook) return;

            const collectionName =
                deletingBook.collectionName ??
                this.deps.cleanup.defaultCollectionName(deletingBook.id);
            const fileReferences =
                await this.deps.references.countLiveFileReferences(
                    deletingBook.fileKey,
                    deletingBook.id
                );
            if (fileReferences === 0) {
                await this.deps.cleanup.deleteFile(deletingBook.fileKey);
            }

            const collectionReferences =
                await this.deps.references.countLiveCollectionReferences(
                    collectionName,
                    deletingBook.id
                );
            if (collectionReferences === 0) {
                await this.deps.cleanup.deleteVectorCollection(collectionName);
                await this.deps.cleanup.deleteSearchChunks(collectionName);
                this.deps.cleanup.clearCache(collectionName);
            }

            await this.deps.deletion.deleteDeletingRow(bookId, userId);
        });
    }
}
