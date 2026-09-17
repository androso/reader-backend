import { eq } from "drizzle-orm";
import type { SearchIndexStore, TextChunk } from "@reader/processing";
import {
    createLogger,
    type BookSearchChunk,
    type BookSearchChunkMetadata,
} from "@reader/providers";
import { db } from "../db";
import { BookSearchChunks } from "../db/schema";

const log = createLogger("BookSearchChunkStore");

export type { BookSearchChunk };

export const createChunkId = (collectionName: string, chunkIndex: number) =>
    `${collectionName}_${chunkIndex}`;

const normalizeChunk = (
    chunk: TextChunk
): { content: string; metadata?: BookSearchChunkMetadata | null } =>
    typeof chunk === "string"
        ? { content: chunk, metadata: null }
        : { content: chunk.content, metadata: chunk.metadata };

export const createBookSearchChunkStore = (
    database = db
): SearchIndexStore & {
    getCollectionChunks(collectionName: string): Promise<BookSearchChunk[]>;
    deleteCollectionChunks(collectionName: string): Promise<void>;
} => ({
    async replaceCollectionChunks(collectionName, chunks) {
        log.info("Replacing collection chunks in DB", {
            collectionName,
            chunkCount: chunks.length,
        });
        await database.transaction(async (tx) => {
            await tx
                .delete(BookSearchChunks)
                .where(eq(BookSearchChunks.collectionName, collectionName));
            log.debug("Deleted existing collection chunks", { collectionName });

            if (!chunks.length) return;
            await tx.insert(BookSearchChunks).values(
                chunks.map((chunk, chunkIndex) => {
                    const normalized = normalizeChunk(chunk);
                    return {
                        id: createChunkId(collectionName, chunkIndex),
                        collectionName,
                        chunkIndex,
                        content: normalized.content,
                        metadata: normalized.metadata,
                    };
                })
            );
        });
        log.info("Inserted collection chunks", {
            collectionName,
            chunkCount: chunks.length,
        });
    },

    async getCollectionChunks(collectionName) {
        log.debug("Fetching collection chunks from DB", { collectionName });
        const chunks = await database
            .select()
            .from(BookSearchChunks)
            .where(eq(BookSearchChunks.collectionName, collectionName))
            .orderBy(BookSearchChunks.chunkIndex);
        log.debug("Fetched collection chunks", {
            collectionName,
            chunkCount: chunks.length,
        });
        return chunks;
    },

    async deleteCollectionChunks(collectionName) {
        log.info("Deleting collection chunks from DB", { collectionName });
        await database
            .delete(BookSearchChunks)
            .where(eq(BookSearchChunks.collectionName, collectionName));
        log.info("Deleted collection chunks from DB", { collectionName });
    },
});

export const bookSearchChunkStore = createBookSearchChunkStore();
