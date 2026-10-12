import type { StorageProvider, VectorStoreProvider } from "@reader/providers";
import { storageProvider, vectorStore, createLogger } from "@reader/providers";
import { extractEpubChunks } from "./epubIngestion";
import { extractPdfChunks } from "./pdfIngestion";

const log = createLogger("bookProcessing");

export type BookFileType = "epub" | "pdf";

export interface ProcessBookInput {
    bookId: string;
    fileKey: string;
    fileType: BookFileType;
    collectionName?: string;
    signal?: AbortSignal;
}

export interface ProcessBookDependencies {
    storage: StorageProvider;
    vectorStore: VectorStoreProvider;
    searchIndexStore?: SearchIndexStore;
    createEpubCollectionName?: (fileBuffer: Buffer) => Promise<string>;
    extractEpubChunks?: (fileBuffer: Buffer) => Promise<TextChunk[]>;
    createPdfCollectionName?: (fileBuffer: Buffer) => Promise<string>;
    extractPdfChunks?: (fileBuffer: Buffer) => Promise<TextChunk[]>;
}

export interface TextChunkMetadata {
    chapterTitle?: string;
    chapterIndex?: number;
    pageNumber?: number;
    blockIndex?: number;
}

export interface ProcessedTextChunk {
    content: string;
    metadata?: TextChunkMetadata | null;
}

export type TextChunk = string | ProcessedTextChunk;

export interface SearchIndexStore {
    replaceCollectionChunks(
        collectionName: string,
        chunks: TextChunk[]
    ): Promise<void>;
}

export interface ProcessBookResult {
    collectionName: string;
    chunks: number;
    reusedCollection: boolean;
}

export const createBookCollectionName = (bookId: string) =>
    `book_${bookId.replace(/-/g, "_")}`;

export const createBookAttemptCollectionName = (
    bookId: string,
    attemptId: string
) => `${createBookCollectionName(bookId)}_${attemptId}`;

export const processBookForSearch = async (
    input: ProcessBookInput,
    dependencies: ProcessBookDependencies = {
        storage: storageProvider,
        vectorStore,
    }
): Promise<ProcessBookResult> => {
    const start = Date.now();
    log.info("Starting book processing", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        fileType: input.fileType,
    });

    log.info("Fetching file from storage", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        fileType: input.fileType,
    });
    const fileBuffer = await dependencies.storage.getFile(input.fileKey);
    log.info("File fetched from storage", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        fileSizeBytes: fileBuffer.length,
        fileType: input.fileType,
    });

    const epubChunks = dependencies.extractEpubChunks ?? extractEpubChunks;
    const pdfChunks = dependencies.extractPdfChunks ?? extractPdfChunks;

    log.info("Generating book-scoped collection name", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        fileType: input.fileType,
    });
    const collectionName =
        input.collectionName ?? createBookCollectionName(input.bookId);
    log.info("Collection name generated", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        collectionName,
    });

    log.info("Resetting collection before ingestion", {
        collectionName,
        bookId: input.bookId,
        fileKey: input.fileKey,
    });
    input.signal?.throwIfAborted();
    await dependencies.vectorStore.resetCollection(collectionName);
    input.signal?.throwIfAborted();
    await dependencies.searchIndexStore?.replaceCollectionChunks(
        collectionName,
        []
    );

    log.info("Extracting text chunks", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        fileType: input.fileType,
        collectionName,
    });
    const chunks =
        input.fileType === "pdf"
            ? await pdfChunks(fileBuffer)
            : await epubChunks(fileBuffer);
    const documents = chunks.map((chunk) =>
        typeof chunk === "string" ? chunk : chunk.content
    );

    log.info("Text chunks extracted", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        collectionName,
        chunkCount: chunks.length,
        firstChunkLength: documents[0]?.length,
        lastChunkLength: documents[documents.length - 1]?.length,
    });

    if (!documents.length) {
        log.error("No valid text chunks extracted", {
            bookId: input.bookId,
            fileKey: input.fileKey,
            fileType: input.fileType,
        });
        throw new Error("No valid text chunks extracted");
    }

    log.info("Storing chunks in search index", {
        collectionName,
        chunkCount: chunks.length,
    });
    input.signal?.throwIfAborted();
    await dependencies.searchIndexStore?.replaceCollectionChunks(
        collectionName,
        chunks
    );
    log.info("Search index chunks stored", {
        collectionName,
        chunkCount: chunks.length,
    });

    log.info("Adding chunks to vector store", {
        collectionName,
        chunkCount: chunks.length,
    });
    input.signal?.throwIfAborted();
    await dependencies.vectorStore.addDocuments(collectionName, documents);

    const duration = Date.now() - start;
    log.info("Book processing complete", {
        bookId: input.bookId,
        fileKey: input.fileKey,
        collectionName,
        chunkCount: chunks.length,
        durationMs: duration,
    });

    return {
        collectionName,
        chunks: chunks.length,
        reusedCollection: false,
    };
};
