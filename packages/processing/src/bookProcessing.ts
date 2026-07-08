import type { StorageProvider, VectorStoreProvider } from "@reader/providers";
import { storageProvider, vectorStore, createLogger } from "@reader/providers";
import { createEpubCollectionName, extractEpubChunks } from "./epubIngestion";
import { createPdfCollectionName, extractPdfChunks } from "./pdfIngestion";

const log = createLogger("bookProcessing");

export type BookFileType = "epub" | "pdf";

export interface ProcessBookInput {
    fileKey: string;
    fileType: BookFileType;
    existingReadyCollectionName?: string | null;
    hasReadyBookForCollection?: boolean;
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

export const processBookForSearch = async (
    input: ProcessBookInput,
    dependencies: ProcessBookDependencies = {
        storage: storageProvider,
        vectorStore,
    }
): Promise<ProcessBookResult> => {
    const start = Date.now();
    log.info("Starting book processing", {
        fileKey: input.fileKey,
        fileType: input.fileType,
        hasExistingReadyCollection: Boolean(input.existingReadyCollectionName),
        hasReadyBookForCollection: Boolean(input.hasReadyBookForCollection),
    });

    if (input.existingReadyCollectionName) {
        log.info("Reusing existing ready collection", {
            fileKey: input.fileKey,
            collectionName: input.existingReadyCollectionName,
        });
        return {
            collectionName: input.existingReadyCollectionName,
            chunks: 0,
            reusedCollection: true,
        };
    }

    log.info("Fetching file from storage", {
        fileKey: input.fileKey,
        fileType: input.fileType,
    });
    const fileBuffer = await dependencies.storage.getFile(input.fileKey);
    log.info("File fetched from storage", {
        fileKey: input.fileKey,
        fileSizeBytes: fileBuffer.length,
        fileType: input.fileType,
    });

    const epubCollectionName =
        dependencies.createEpubCollectionName ?? createEpubCollectionName;
    const epubChunks = dependencies.extractEpubChunks ?? extractEpubChunks;
    const pdfCollectionName =
        dependencies.createPdfCollectionName ?? createPdfCollectionName;
    const pdfChunks = dependencies.extractPdfChunks ?? extractPdfChunks;

    log.info("Generating collection name", {
        fileKey: input.fileKey,
        fileType: input.fileType,
    });
    const collectionName =
        input.fileType === "pdf"
            ? await pdfCollectionName(fileBuffer)
            : await epubCollectionName(fileBuffer);
    log.info("Collection name generated", {
        fileKey: input.fileKey,
        collectionName,
    });

    if (!input.hasReadyBookForCollection) {
        log.info("Resetting collection before ingestion", {
            collectionName,
            fileKey: input.fileKey,
        });
        await dependencies.vectorStore.resetCollection(collectionName);
        await dependencies.searchIndexStore?.replaceCollectionChunks(
            collectionName,
            []
        );
    } else {
        log.info("Skipping collection reset: ready book already exists", {
            collectionName,
        });
    }

    log.info("Extracting text chunks", {
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
        fileKey: input.fileKey,
        collectionName,
        chunkCount: chunks.length,
        firstChunkLength: documents[0]?.length,
        lastChunkLength: documents[documents.length - 1]?.length,
    });

    if (!documents.length) {
        log.error("No valid text chunks extracted", {
            fileKey: input.fileKey,
            fileType: input.fileType,
        });
        throw new Error("No valid text chunks extracted");
    }

    log.info("Storing chunks in search index", {
        collectionName,
        chunkCount: chunks.length,
    });
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
    await dependencies.vectorStore.addDocuments(collectionName, documents);

    const duration = Date.now() - start;
    log.info("Book processing complete", {
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
