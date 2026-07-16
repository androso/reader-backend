import crypto from "node:crypto";
import OpenAI from "openai";
import { Pool } from "pg";
import {
    OPENAI_CHAT_MODELS,
    OpenAIService,
    bookSearchChunkStore,
    closeDatabasePool,
    generateBookAnswer,
    retrieveBookContext,
} from "@reader/api/rag";
import {
    estimateModelCost,
    normalizeModelUsage,
} from "@reader/api/ai-usage";
import {
    createBookCollectionName,
    processBookForSearch,
} from "@reader/processing";
import { storageProvider, vectorStore } from "@reader/providers";
import type {
    PreparedEvalCase,
    RagEvalCase,
    RagEvalFixture,
    RagEvalIngestion,
} from "./types";
import {
    getFixture,
    loadFixtureManifest,
    verifyFixture,
} from "./fixtures";
import { resolveLiveEvalSources } from "./retrieval";
const evalAnswerService = new OpenAIService(
    new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 2,
        timeout: 30_000,
    })
);

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
    collectionName?: string;
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
            async () => {
                if (collectionName) {
                    await bookSearchChunkStore.deleteCollectionChunks(
                        collectionName
                    );
                }
            },
        ],
        [
            "Chroma collection",
            async () => {
                if (collectionName) {
                    await vectorStore.deleteCollection(collectionName);
                }
            },
        ],
        ["fixture object", () => storageProvider.deleteFile(fileKey)],
        ["API database pool", closeDatabasePool],
        ["eval database pool", () => pool.end()],
    ];

    for (const [label, operation] of operations) {
        try {
            await operation();
        } catch (error) {
            console.warn(`Could not clean up ${label}:`, error);
        }
    }
};

export const runLiveRagEval = async (
    cases: RagEvalCase[]
): Promise<{
    cases: PreparedEvalCase[];
    retrievalCases: PreparedEvalCase[];
    fixture: RagEvalFixture;
    ingestion: RagEvalIngestion;
    answerModels: string[];
    resolvedAnswerModels: string[];
}> => {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required for live RAG evals");
    }
    const fixture = getFixture(await loadFixtureManifest(), "alice");
    const { buffer: fixtureBuffer } = await verifyFixture(fixture);

    const runToken = crypto.randomUUID().replace(/-/g, "");
    const fileKey = `rag-evals/${runToken}/alice-in-wonderland.epub`;
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    let userId: string | undefined;
    let bookId: string | undefined;
    let collectionName: string | undefined;

    try {
        await storageProvider.uploadFile(fileKey, fixtureBuffer);
        const userResult = await pool.query<{ id: string }>(
            `INSERT INTO users (email, name)
             VALUES ($1, $2)
             RETURNING id`,
            [`rag-eval-${runToken}@reader.invalid`, "Reader RAG Eval"]
        );
        userId = userResult.rows[0].id;
        const bookResult = await pool.query<{ id: string }>(
            `INSERT INTO books
                (title, user_id, file_key, file_type, processing_status)
             VALUES ($1, $2, $3, 'epub', 'processing')
             RETURNING id`,
            ["Alice's Adventures in Wonderland", userId, fileKey]
        );
        bookId = bookResult.rows[0].id;
        collectionName = createBookCollectionName(bookId);

        const processed = await processBookForSearch(
            {
                bookId,
                fileKey,
                fileType: "epub",
            },
            {
                storage: storageProvider,
                vectorStore,
                searchIndexStore: bookSearchChunkStore,
            }
        );
        if (processed.collectionName !== collectionName) {
            throw new Error(
                `Unexpected collection name: expected ${collectionName}, received ${processed.collectionName}`
            );
        }
        await pool.query(
            `UPDATE books
             SET collection_name = $2, processing_status = 'ready'
             WHERE id = $1`,
            [bookId, collectionName]
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
            const sources = resolveLiveEvalSources(testCase, rag);

            const vectorResults = await vectorStore.searchDocuments(
                collectionName,
                testCase.question,
                20
            );
            for (const answerModel of OPENAI_CHAT_MODELS) {
                const generated = await generateBookAnswer({
                    messages: rag.messages,
                    model: answerModel,
                    options: { temperature: 0 },
                    service: evalAnswerService,
                });
                if (!generated.answer.trim()) {
                    throw new Error(
                        `Reader generated an empty answer for ${testCase.id} using ${answerModel}`
                    );
                }
                const answerUsage = normalizeModelUsage(generated.usage);

                preparedCases.push({
                    ...testCase,
                    answerModel,
                    resolvedAnswerModel: generated.modelVersion,
                    expectedChunkId: expectedChunk?.id,
                    candidateAnswer: generated.answer,
                    sources,
                    vectorResultIds: vectorResults.map((result) => result.id),
                    vectorIdsAligned: vectorResults.every((result) =>
                        storedIds.has(result.id)
                    ),
                    pipelineVersion: rag.telemetry.pipelineVersion,
                    promptVersion: rag.telemetry.promptVersion,
                    retrievalDurationMs:
                        rag.telemetry.retrieval?.durationMs ?? 0,
                    generationDurationMs: generated.durationMs,
                    answerUsage,
                    answerEstimatedCost: estimateModelCost(
                        generated.modelVersion,
                        answerUsage
                    ),
                });
            }
        }

        return {
            cases: preparedCases,
            retrievalCases: preparedCases.filter(
                (testCase) => testCase.answerModel === OPENAI_CHAT_MODELS[0]
            ),
            answerModels: [...OPENAI_CHAT_MODELS],
            resolvedAnswerModels: [
                ...new Set(
                    preparedCases.map(
                        (testCase) => testCase.resolvedAnswerModel
                    )
                ),
            ],
            fixture,
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
