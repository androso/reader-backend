import crypto from "node:crypto";
import OpenAI from "openai";
import { Pool } from "pg";
import {
    OPENAI_CHAT_MODELS,
    OpenAIService,
    bookSearchChunkStore,
    buildRetrievalQuery,
    closeDatabasePool,
    generateBookAnswer,
    normalizeHighlightContext,
    retrieveBookContext,
} from "@reader/api/rag";
import { estimateModelCost, normalizeModelUsage } from "@reader/api/ai-usage";
import {
    createBookCollectionName,
    processBookForSearch,
} from "@reader/processing";
import { storageProvider, vectorStore } from "@reader/providers";
import type {
    ExpectedEvidenceAnchor,
    PreparedEvalCase,
    RagEvalCase,
    RagEvalFixture,
    RagEvalIngestion,
} from "./types";
import { getFixture, loadFixtureManifest, verifyFixture } from "./fixtures";
import { resolveLiveEvalSources } from "./retrieval";

const evalAnswerService = new OpenAIService(
    new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 2,
        timeout: 30_000,
    })
);

export type StoredChunk = {
    id: string;
    chunkIndex: number;
    content: string;
    metadata: { chapterTitle?: string } | null;
};

type FixtureRuntime = {
    fixture: RagEvalFixture;
    fileKey: string;
    bookId: string;
    collectionName: string;
    chunks: StoredChunk[];
    storedIds: Set<string>;
    ingestion: RagEvalIngestion;
};

export type EvalCleanupResource = {
    fixtureId: string;
    fileKey: string;
    bookId?: string;
    collectionName?: string;
};

export type EvalCleanupDependencies = {
    deleteBook: (bookId: string) => Promise<unknown>;
    deleteUser: (userId: string) => Promise<unknown>;
    deleteSearchChunks: (collectionName: string) => Promise<unknown>;
    deleteVectorCollection: (collectionName: string) => Promise<unknown>;
    deleteStoredObject: (fileKey: string) => Promise<unknown>;
    closeApiPool: () => Promise<unknown>;
    closeEvalPool: () => Promise<unknown>;
    warn?: (message: string, error: unknown) => void;
};

const normalizeText = (value: string) =>
    value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();

export const resolveExpectedChunks = (
    testCase: RagEvalCase,
    chunks: StoredChunk[]
) =>
    (testCase.expectedEvidence ?? []).map(
        (anchor: ExpectedEvidenceAnchor, index) => {
            const evidence = normalizeText(anchor.text);
            const matches = chunks.filter(
                (chunk) =>
                    normalizeText(chunk.content).includes(evidence) &&
                    (!anchor.chapterTitle ||
                        chunk.metadata?.chapterTitle === anchor.chapterTitle)
            );
            if (matches.length !== 1) {
                throw new Error(
                    `Expected exactly one evidence chunk for ${testCase.id} anchor ${index + 1}, found ${matches.length}`
                );
            }
            return matches[0];
        }
    );

export const assertTargetBookIds = (
    label: "retrieved" | "vector",
    ids: string[],
    targetIds: Set<string>,
    caseId: string
) => {
    const foreignIds = ids.filter((id) => !targetIds.has(id));
    if (foreignIds.length) {
        throw new Error(
            `${caseId} returned ${label} IDs outside the target book: ${foreignIds.join(", ")}`
        );
    }
};

export const assertCrossUserIsolation = (fixtureId: string, status: string) => {
    if (status !== "not_found") {
        throw new Error(
            `Cross-user retrieval for ${fixtureId} returned ${status}, expected not_found`
        );
    }
};

export const cleanupEvalResources = async (
    resources: EvalCleanupResource[],
    userIds: string[],
    dependencies: EvalCleanupDependencies
) => {
    const warn =
        dependencies.warn ??
        ((message: string, error: unknown) => console.warn(message, error));
    const run = async (label: string, operation: () => Promise<unknown>) => {
        try {
            await operation();
        } catch (error) {
            warn(`Could not clean up ${label}`, error);
        }
    };

    for (const resource of resources) {
        if (resource.bookId) {
            await run(`database book ${resource.fixtureId}`, () =>
                dependencies.deleteBook(resource.bookId!)
            );
        }
        if (resource.collectionName) {
            await run(`search chunks ${resource.fixtureId}`, () =>
                dependencies.deleteSearchChunks(resource.collectionName!)
            );
            await run(`Chroma collection ${resource.fixtureId}`, () =>
                dependencies.deleteVectorCollection(resource.collectionName!)
            );
        }
        await run(`fixture object ${resource.fixtureId}`, () =>
            dependencies.deleteStoredObject(resource.fileKey)
        );
    }
    for (const userId of userIds) {
        await run(`database user ${userId}`, () =>
            dependencies.deleteUser(userId)
        );
    }
    await run("API database pool", dependencies.closeApiPool);
    await run("eval database pool", dependencies.closeEvalPool);
};

export const runLiveRagEval = async (
    cases: RagEvalCase[]
): Promise<{
    cases: PreparedEvalCase[];
    retrievalCases: PreparedEvalCase[];
    fixtures: RagEvalFixture[];
    ingestion: RagEvalIngestion[];
    answerModels: string[];
    resolvedAnswerModels: string[];
}> => {
    if (!process.env.DATABASE_URL) {
        throw new Error("DATABASE_URL is required for live RAG evals");
    }

    const manifest = await loadFixtureManifest();
    for (const testCase of cases) getFixture(manifest, testCase.fixtureId);
    const fixtures = manifest;
    const runToken = crypto.randomUUID().replace(/-/g, "");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const cleanupResources: EvalCleanupResource[] = [];
    const userIds: string[] = [];
    const runtimes = new Map<string, FixtureRuntime>();

    try {
        const primaryUser = await pool.query<{ id: string }>(
            `INSERT INTO users (email, name)
             VALUES ($1, $2)
             RETURNING id`,
            [`rag-eval-${runToken}@reader.invalid`, "Reader RAG Eval"]
        );
        const primaryUserId = primaryUser.rows[0].id;
        userIds.push(primaryUserId);

        const isolationUser = await pool.query<{ id: string }>(
            `INSERT INTO users (email, name)
             VALUES ($1, $2)
             RETURNING id`,
            [
                `rag-eval-isolation-${runToken}@reader.invalid`,
                "Reader RAG Isolation Eval",
            ]
        );
        const isolationUserId = isolationUser.rows[0].id;
        userIds.push(isolationUserId);

        for (const fixture of fixtures) {
            const { buffer } = await verifyFixture(fixture);
            const fileKey = `rag-evals/${runToken}/${fixture.fileName}`;
            const cleanupResource: EvalCleanupResource = {
                fixtureId: fixture.id,
                fileKey,
            };
            cleanupResources.push(cleanupResource);
            await storageProvider.uploadFile(fileKey, buffer);

            const bookResult = await pool.query<{ id: string }>(
                `INSERT INTO books
                    (title, user_id, file_key, file_type, processing_status)
                 VALUES ($1, $2, $3, 'epub', 'processing')
                 RETURNING id`,
                [fixture.title, primaryUserId, fileKey]
            );
            const bookId = bookResult.rows[0].id;
            const collectionName = createBookCollectionName(bookId);
            cleanupResource.bookId = bookId;
            cleanupResource.collectionName = collectionName;

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
                    `Unexpected collection name for ${fixture.id}: expected ${collectionName}, received ${processed.collectionName}`
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
                    `${fixture.id} stored ${storedResult.rowCount ?? 0} of ${processed.chunks} extracted chunks`
                );
            }

            runtimes.set(fixture.id, {
                fixture,
                fileKey,
                bookId,
                collectionName,
                chunks: storedResult.rows,
                storedIds: new Set(storedResult.rows.map((chunk) => chunk.id)),
                ingestion: {
                    fixtureId: fixture.id,
                    bookId,
                    collectionName,
                    extractedChunkCount: processed.chunks,
                    storedChunkCount: storedResult.rowCount ?? 0,
                },
            });
        }

        for (const runtime of runtimes.values()) {
            const isolated = await retrieveBookContext({
                bookId: runtime.bookId,
                userId: isolationUserId,
                messages: [{ role: "user", content: "isolation check" }],
                query: "isolation check",
                strict: true,
            });
            assertCrossUserIsolation(runtime.fixture.id, isolated.status);
        }

        const preparedCases: PreparedEvalCase[] = [];
        for (const testCase of cases) {
            const runtime = runtimes.get(testCase.fixtureId);
            if (!runtime) {
                throw new Error(
                    `Fixture ${testCase.fixtureId} was not ingested for ${testCase.id}`
                );
            }
            const expectedChunks = resolveExpectedChunks(
                testCase,
                runtime.chunks
            );
            const highlightContext = normalizeHighlightContext(
                testCase.highlightContext
            );
            const query = buildRetrievalQuery(
                testCase.question,
                highlightContext
            );
            const messages = [
                ...(testCase.priorMessages ?? []),
                { role: "user" as const, content: testCase.question },
            ];
            const rag = await retrieveBookContext({
                bookId: runtime.bookId,
                userId: primaryUserId,
                messages,
                query,
                highlightContext,
                strict: true,
            });
            const sources = resolveLiveEvalSources(testCase, rag);
            assertTargetBookIds(
                "retrieved",
                sources.map((source) => source.id),
                runtime.storedIds,
                testCase.id
            );

            const vectorResults = await vectorStore.searchDocuments(
                runtime.collectionName,
                query,
                20
            );
            const vectorResultIds = vectorResults.map((result) => result.id);
            assertTargetBookIds(
                "vector",
                vectorResultIds,
                runtime.storedIds,
                testCase.id
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
                    expectedChunkId: expectedChunks[0]?.id,
                    expectedChunkIds: expectedChunks.map((chunk) => chunk.id),
                    candidateAnswer: generated.answer,
                    sources,
                    vectorResultIds,
                    vectorIdsAligned: true,
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
            fixtures,
            ingestion: [...runtimes.values()].map(
                (runtime) => runtime.ingestion
            ),
        };
    } finally {
        await cleanupEvalResources(cleanupResources, userIds, {
            deleteBook: (bookId) =>
                pool.query("DELETE FROM books WHERE id = $1", [bookId]),
            deleteUser: (userId) =>
                pool.query("DELETE FROM users WHERE id = $1", [userId]),
            deleteSearchChunks: (collectionName) =>
                bookSearchChunkStore.deleteCollectionChunks(collectionName),
            deleteVectorCollection: (collectionName) =>
                vectorStore.deleteCollection(collectionName),
            deleteStoredObject: (fileKey) =>
                storageProvider.deleteFile(fileKey),
            closeApiPool: closeDatabasePool,
            closeEvalPool: () => pool.end(),
        });
    }
};
