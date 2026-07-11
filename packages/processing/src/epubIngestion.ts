import crypto from "crypto";
import { JSDOM } from "jsdom";
import {
    extractEpubTextBlocks,
    processEpubBuffer,
} from "@reader/epub/dist/server";
import { TextChunker } from "./chunkText";
import type { ProcessedTextChunk } from "./bookProcessing";

export const createEpubCollectionName = async (fileBuffer: Buffer) => {
    const [content] = await processEpubBuffer(fileBuffer);
    const normalized = {
        title: content.metadata.title?.trim(),
        creator: content.metadata.creator?.trim(),
        identifier: content.metadata.identifier?.trim(),
    };
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(normalized));
    return `book_${hash.digest("hex").slice(0, 12)}`;
};

export const extractEpubChunks = async (
    fileBuffer: Buffer,
    chunker = new TextChunker()
) => {
    const { chapters } = await extractEpubTextBlocks(fileBuffer);
    const chunks: ProcessedTextChunk[] = [];

    for (const [chapterIndex, chapter] of chapters.entries()) {
        for (const [blockIndex, block] of chapter.textBlocks.entries()) {
            const text =
                new JSDOM(block.content).window.document.body.textContent || "";
            chunks.push(
                ...chunker.chunkText(text).map((content) => ({
                    content,
                    metadata: {
                        chapterTitle: chapter.id || chapter.hrefId,
                        chapterIndex,
                        blockIndex,
                    },
                }))
            );
        }
    }

    return chunks;
};
