import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import {
    OPENAI_CHAT_MODEL,
    bookSearchChunkStore,
    generateBookAnswer,
    retrieveBookContext,
} from "@reader/api/rag";
import {
    createEpubCollectionName,
    processBookForSearch,
} from "@reader/processing";
import { storageProvider, vectorStore } from "@reader/providers";
import type {
    PreparedEvalCase,
    RagEvalCase,
    RagEvalFixture,
    RagEvalIngestion,
} from "./types";

const FIXTURE_PATH = path.resolve(
    __dirname,
    "../fixtures/alice-in-wonderland.epub"
);
const FIXTURE_SHA256 =
    "d422c4b00899d58b6e4f92d2fa5efc37ceb425aea6c1354c6564b64e051d505a";
const FIXTURE_SOURCE_REVISION = "dfe3e6099b7633b729bec1ce65a66997c515c845";
const FIXTURE_SOURCE_URL =
    "https://github.com/standardebooks/lewis-carroll_alices-adventures-in-wonderland_john-tenniel";

type StoredChunk = {
    id: string;
    chunkIndex: number;
    content: string;
    metadata: { chapterTitle?: string } | null;
};

const normalizeText = (value: string) =>
    value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

const resolveExpectedChunk = (testCase: RagEvalCase, chunks: StoredChunk[]) => {
    if (!testCase.expectedEvidenceText) return undefined;
    const evidence = normalizeText(testCase.expectedEvidenceText);
    const matches = chunks.filter(
        (chunk) =>
            normalizeText(chunk.content).includes(evidence) &&
            (!testCase.expectedChapterTitle ||
                chunk.metadata?.chapterTitle === testCase.expectedChapterTitle)
    );

    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one evidence chunk for ${testCase.id}, found ${matches.length}`
        );
    }
    return matches[0];
};

const cleanup = async ({
    pool,
    userId,
    bookId,
    collectionName,
    fileKey,
}: {
    pool: Pool;
    userId?: string;
    bookId?: string;
    collectionName: string;
    fileKey: string;
}) => {
    const operations: Array<[string, () => Promise<unknown>]> = [
        [
            "database book",
            async () => {
                if (bookId) {
                    await pool.query("DELETE FROM books WHERE id = $1", [
                        bookId,
                    ]);
                }
            },
        ],
        [
            "database user",
            async () => {
                if (userId) {
                    await pool.query("DELETE FROM users WHERE id = $1", [
                        userId,
                    ]);
                }
            },
        ],
        [
            "search chunks",
            () => bookSearchChunkStore.deleteCollectionChunks(collectionName),
        ],
        [
            "Chroma collection",
            () => vectorStore.deleteCollection(collectionName),
        ],
        ["fixture object", () => storageProvider.deleteFile(fileKey)],
    ];

    for (const [label, operation] of operations) {
        try {
            await operation();
        } catch (error) {
            console.warn(`Could not clean up ${label}:`, error);
        }
    }
    await pool.end();
};

export const runLiveRagEval = async (
    cases: RagEvalCase[]
): Promise<{
    cases: PreparedEvalCase[];
    fixture: RagEvalFixture;
    ingestion: RagEvalIngestion;
    answerModel: string;
}> => {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required for live RAG evals");
    }
    const fixtureBuffer = await fs.readFile(FIXTURE_PATH);
    const fixtureHash = crypto
        .createHash("sha256")
        .update(fixtureBuffer)
        .digest("hex");
    if (fixtureHash !== FIXTURE_SHA256) {
        throw new Error(
            `Alice EPUB checksum mismatch: expected ${FIXTURE_SHA256}, received ${fixtureHash}`
        );
    }

    const runToken = crypto.randomUUID().replace(/-/g, "");
    const baseCollectionName = await createEpubCollectionName(fixtureBuffer);
    const collectionName = `${baseCollectionName}_${runToken}`;
    const fileKey = `rag-evals/${runToken}/alice-in-wonderland.epub`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    let bookId: string | undefined;

    try {
        await storageProvider.uploadFile(fileKey, fixtureBuffer);
        const processed = await processBookForSearch(
            {
                fileKey,
                fileType: "epub",
                hasReadyBookForCollection: false,
            },
            {
                storage: storageProvider,
                vectorStore,
                searchIndexStore: bookSearchChunkStore,
                createEpubCollectionName: async () => collectionName,
            }
        );

        const storedResult = await pool.query<StoredChunk>(
            `SELECT id, chunk_index AS "chunkIndex", content, metadata
             FROM book_search_chunks
             WHERE collection_name = $1
             ORDER BY chunk_index`,
            [collectionName]
        );
        if (storedResult.rowCount !== processed.chunks) {
            throw new Error(
                `Stored ${storedResult.rowCount ?? 0} of ${processed.chunks} extracted chunks`
            );
        }
        const storedIds = new Set(storedResult.rows.map((chunk) => chunk.id));

        const userResult = await pool.query<{ id: string }>(
            `INSERT INTO users (email, name)
             VALUES ($1, $2)
             RETURNING id`,
            [`rag-eval-${runToken}@reader.invalid`, "Reader RAG Eval"]
        );
        userId = userResult.rows[0].id;
        const bookResult = await pool.query<{ id: string }>(
            `INSERT INTO books
                (title, user_id, file_key, file_type, collection_name, processing_status)
             VALUES ($1, $2, $3, 'epub', $4, 'ready')
             RETURNING id`,
            [
                "Alice's Adventures in Wonderland",
                userId,
                fileKey,
                collectionName,
            ]
        );
        bookId = bookResult.rows[0].id;

        const preparedCases: PreparedEvalCase[] = [];
        for (const testCase of cases) {
            const expectedChunk = resolveExpectedChunk(
                testCase,
                storedResult.rows
            );
            const rag = await retrieveBookContext({
                bookId,
                userId,
                messages: [{ role: "user", content: testCase.question }],
                query: testCase.question,
                strict: true,
            });
            if (rag.status !== "ready" || !rag.sources?.length) {
                throw new Error(
                    `Reader did not produce RAG context for ${testCase.id}`
                );
            }

            const vectorResults = await vectorStore.searchDocuments(
                collectionName,
                testCase.question,
                20
            );
            const generated = await generateBookAnswer({
                messages: rag.messages,
                model: OPENAI_CHAT_MODEL,
            });
            if (!generated.answer.trim()) {
                throw new Error(
                    `Reader generated an empty answer for ${testCase.id}`
                );
            }

            preparedCases.push({
                ...testCase,
                expectedChunkId: expectedChunk?.id,
                candidateAnswer: generated.answer,
                sources: rag.sources,
                vectorResultIds: vectorResults.map((result) => result.id),
                vectorIdsAligned: vectorResults.every((result) =>
                    storedIds.has(result.id)
                ),
            });
        }

        return {
            cases: preparedCases,
            answerModel: OPENAI_CHAT_MODEL,
            fixture: {
                title: "Alice's Adventures in Wonderland",
                author: "Lewis Carroll",
                sourceUrl: FIXTURE_SOURCE_URL,
                sourceRevision: FIXTURE_SOURCE_REVISION,
                sha256: FIXTURE_SHA256,
                sizeBytes: fixtureBuffer.length,
            },
            ingestion: {
                collectionName,
                extractedChunkCount: processed.chunks,
                storedChunkCount: storedResult.rowCount ?? 0,
            },
        };
    } finally {
        await cleanup({
            pool,
            userId,
            bookId,
            collectionName,
            fileKey,
        });
    }
};
