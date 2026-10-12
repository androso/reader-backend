import MiniSearch from "minisearch";
import { contentFreeQueryLogMetadata, createLogger } from "./logger";
import {
    deriveHybridSearchResponse,
    hydrateVectorResults,
} from "@reader/application";
import {
    vectorStore,
    type VectorSearchResult,
    type VectorStoreProvider,
} from "./vectorStore";

const log = createLogger("hybridSearch");

export interface BookSearchChunkMetadata {
    chapterTitle?: string;
    chapterIndex?: number;
    pageNumber?: number;
    blockIndex?: number;
}

export interface BookSearchChunk {
    id: string;
    collectionName: string;
    chunkIndex: number;
    content: string;
    metadata?: BookSearchChunkMetadata | null;
}

export interface BookSearchChunkReader {
    getCollectionChunks(collectionName: string): Promise<BookSearchChunk[]>;
}

export interface RankedSearchResult {
    id: string;
    content: string;
    chunkIndex: number;
    score: number;
    bestRank: number;
    metadata?: BookSearchChunkMetadata | null;
}

export interface HybridSearchCandidateDiagnostic {
    id: string;
    rank: number;
    score?: number;
    distance?: number;
}

export interface HybridSearchDiagnostics {
    mode: "hybrid" | "vector_only";
    durationMs: number;
    lexicalCandidates: HybridSearchCandidateDiagnostic[];
    vectorCandidates: HybridSearchCandidateDiagnostic[];
    selectedCandidates: HybridSearchCandidateDiagnostic[];
}

export interface HybridSearchResponse {
    results: RankedSearchResult[];
    diagnostics: HybridSearchDiagnostics;
}

export interface LexicalSearchResult {
    id: string;
    content: string;
    chunkIndex: number;
    rank: number;
    metadata?: BookSearchChunkMetadata | null;
}

export interface HybridSearchTraceObservation {
    update(attributes: Record<string, unknown>): HybridSearchTraceObservation;
    startObservation(
        name: string,
        attributes?: Record<string, unknown>,
        options?: { asType?: string }
    ): HybridSearchTraceObservation;
    end(): void;
}

export interface HybridSearchCaptureConfig {
    mode: "metadata" | "snippets";
    maxChars: number;
}

interface HybridSearchTraceOptions {
    trace?: HybridSearchTraceObservation;
    capture?: HybridSearchCaptureConfig;
}

interface CachedMiniSearchIndex {
    index: MiniSearch<BookSearchChunk>;
    chunksById: Map<string, BookSearchChunk>;
    createdAt: number;
}

const INDEX_CACHE_TTL_MS = 60 * 60 * 1000;

const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const recordObservationError = (
    observation: HybridSearchTraceObservation | undefined,
    error: unknown,
    statusMessage = "Observation failed"
) => {
    observation?.update({
        level: "ERROR",
        statusMessage,
        output: { error: getErrorMessage(error) },
    });
};

const snippetForCapture = (
    text: string,
    capture?: HybridSearchCaptureConfig
) => {
    if (!capture || capture.mode !== "snippets") return undefined;
    return text.replace(/\s+/g, " ").trim().slice(0, capture.maxChars);
};

const summarizeLexicalResults = (
    results: LexicalSearchResult[],
    capture?: HybridSearchCaptureConfig
) =>
    results.slice(0, 5).map((result) => ({
        id: result.id,
        chunkIndex: result.chunkIndex,
        rank: result.rank,
        ...(capture
            ? { snippet: snippetForCapture(result.content, capture) }
            : {}),
    }));

const summarizeVectorResults = (
    results: VectorSearchResult[],
    capture?: HybridSearchCaptureConfig
) =>
    results.slice(0, 5).map((result) => ({
        id: result.id,
        rank: result.rank,
        distance: result.distance,
        ...(capture
            ? { snippet: snippetForCapture(result.content, capture) }
            : {}),
    }));

const summarizeRankedResults = (
    results: RankedSearchResult[],
    capture?: HybridSearchCaptureConfig
) =>
    results.slice(0, 5).map((result) => ({
        id: result.id,
        chunkIndex: result.chunkIndex,
        score: result.score,
        bestRank: result.bestRank,
        ...(capture
            ? { snippet: snippetForCapture(result.content, capture) }
            : {}),
    }));

export class HybridBookSearchService {
    private readonly indexes = new Map<string, CachedMiniSearchIndex>();

    constructor(
        private readonly chunkStore: BookSearchChunkReader,
        private readonly semanticSearch: Pick<
            VectorStoreProvider,
            "searchDocuments"
        > = vectorStore
    ) {}

    clearCollectionCache(collectionName: string) {
        log.info("Clearing hybrid search cache", { collectionName });
        this.indexes.delete(collectionName);
    }

    private async getMiniSearchIndex(collectionName: string) {
        const cached = this.indexes.get(collectionName);
        if (cached && Date.now() - cached.createdAt < INDEX_CACHE_TTL_MS) {
            log.debug("MiniSearch cache hit", { collectionName });
            return cached;
        }

        log.info("Building MiniSearch index", { collectionName });
        const chunks =
            await this.chunkStore.getCollectionChunks(collectionName);
        if (!chunks.length) {
            log.warn("No chunks available to build MiniSearch index", {
                collectionName,
            });
            return null;
        }

        const index = new MiniSearch<BookSearchChunk>({
            fields: ["content"],
            storeFields: ["content", "chunkIndex", "metadata"],
            idField: "id",
        });
        index.addAll(chunks);

        const next = {
            index,
            chunksById: new Map(chunks.map((chunk) => [chunk.id, chunk])),
            createdAt: Date.now(),
        };
        this.indexes.set(collectionName, next);
        const maxEntries =
            Number(process.env.HYBRID_INDEX_CACHE_MAX_ENTRIES) || 100;
        while (this.indexes.size > maxEntries) {
            const oldest = [...this.indexes.entries()].sort(
                (left, right) => left[1].createdAt - right[1].createdAt
            )[0];
            if (!oldest) break;
            this.indexes.delete(oldest[0]);
        }
        log.info("MiniSearch index built", {
            collectionName,
            chunkCount: chunks.length,
        });
        return next;
    }

    async searchLexical(
        collectionName: string,
        query: string,
        limit: number,
        tracing: HybridSearchTraceOptions = {}
    ): Promise<LexicalSearchResult[]> {
        const span = tracing.trace?.startObservation("lexical_search", {
            input: {
                collectionName,
                queryLength: query.length,
                limit,
            },
        });

        if (!query.trim()) {
            log.debug("Empty lexical query, skipping", { collectionName });
            span?.update({ output: { skipped: true, resultCount: 0 } });
            span?.end();
            return [];
        }

        try {
            log.info("Searching lexical index", { collectionName, limit });
            const cached = await this.getMiniSearchIndex(collectionName);
            if (!cached) {
                span?.update({
                    output: {
                        indexed: false,
                        resultCount: 0,
                    },
                });
                return [];
            }

            const results = cached.index
                .search(query, {
                    prefix: true,
                })
                .slice(0, limit)
                .map((result, index) => {
                    const chunk = cached.chunksById.get(String(result.id));
                    return {
                        id: String(result.id),
                        content: String(result.content ?? chunk?.content ?? ""),
                        chunkIndex: Number(
                            result.chunkIndex ?? chunk?.chunkIndex
                        ),
                        rank: index + 1,
                        metadata: (result.metadata ?? chunk?.metadata) as
                            | BookSearchChunkMetadata
                            | null
                            | undefined,
                    };
                })
                .filter((result) => result.content);
            log.info("Lexical search complete", {
                collectionName,
                resultCount: results.length,
            });
            span?.update({
                output: {
                    indexed: true,
                    resultCount: results.length,
                    topResults: summarizeLexicalResults(
                        results,
                        tracing.capture
                    ),
                },
            });
            return results;
        } catch (error) {
            recordObservationError(span, error, "Lexical search failed");
            throw error;
        } finally {
            span?.end();
        }
    }

    async getCollectionChunks(collectionName: string) {
        const cached =
            this.indexes.get(collectionName) ??
            (await this.getMiniSearchIndex(collectionName));
        return cached ? Array.from(cached.chunksById.values()) : [];
    }

    private async searchVector(
        collectionName: string,
        query: string,
        limit: number,
        tracing: HybridSearchTraceOptions = {}
    ): Promise<VectorSearchResult[]> {
        const span = tracing.trace?.startObservation("vector_search", {
            input: {
                collectionName,
                queryLength: query.length,
                limit,
            },
        });

        try {
            const results = await this.semanticSearch.searchDocuments(
                collectionName,
                query,
                limit
            );
            span?.update({
                output: {
                    resultCount: results.length,
                    topResults: summarizeVectorResults(
                        results,
                        tracing.capture
                    ),
                },
            });
            return results;
        } catch (error) {
            recordObservationError(span, error, "Vector search failed");
            throw error;
        } finally {
            span?.end();
        }
    }

    async searchWithDiagnostics(
        collectionName: string,
        query: string,
        options: {
            lexicalLimit?: number;
            vectorLimit?: number;
            finalLimit?: number;
            minScore?: number;
        } = {},
        tracing: HybridSearchTraceOptions = {}
    ): Promise<HybridSearchResponse> {
        const start = Date.now();
        const lexicalLimit = options.lexicalLimit ?? 20;
        const vectorLimit = options.vectorLimit ?? 20;
        const finalLimit = options.finalLimit ?? 5;
        const minScore = options.minScore ?? 0;
        log.info("Starting hybrid search", {
            collectionName,
            lexicalLimit,
            vectorLimit,
            finalLimit,
        });
        log.debug(
            "Search query metadata",
            contentFreeQueryLogMetadata(query, { collectionName })
        );

        const [lexicalResults, vectorResults] = await Promise.all([
            this.searchLexical(collectionName, query, lexicalLimit, tracing),
            this.searchVector(collectionName, query, vectorLimit, tracing),
        ]);
        const chunks = await this.getCollectionChunks(collectionName);
        const hydratedVectorResults = hydrateVectorResults(
            vectorResults,
            chunks
        );

        log.info("Search results before fusion", {
            collectionName,
            lexicalResultCount: lexicalResults.length,
            vectorResultCount: vectorResults.length,
        });

        const response = deriveHybridSearchResponse(
            lexicalResults,
            vectorResults,
            hydratedVectorResults,
            {
                finalLimit,
                minScore,
                durationMs: Date.now() - start,
            }
        );

        if (response.diagnostics.mode === "vector_only") {
            const fallback = response.results;
            log.info("Returning vector-only results", {
                collectionName,
                resultCount: fallback.length,
            });
            tracing.trace?.update({
                output: {
                    mode: response.diagnostics.mode,
                    resultCount: fallback.length,
                    lexicalResultCount: lexicalResults.length,
                    vectorResultCount: vectorResults.length,
                    durationMs: response.diagnostics.durationMs,
                    topResults: summarizeRankedResults(
                        fallback,
                        tracing.capture
                    ),
                },
            });
            return response;
        }

        const fused = response.results;
        const duration = response.diagnostics.durationMs;
        log.info("Hybrid search complete", {
            collectionName,
            resultCount: fused.length,
            durationMs: duration,
            minScore,
        });
        tracing.trace?.update({
            output: {
                mode: response.diagnostics.mode,
                resultCount: fused.length,
                lexicalResultCount: lexicalResults.length,
                vectorResultCount: vectorResults.length,
                durationMs: duration,
                minScore,
                topResults: summarizeRankedResults(fused, tracing.capture),
            },
        });
        return response;
    }

    async search(
        collectionName: string,
        query: string,
        options: {
            lexicalLimit?: number;
            vectorLimit?: number;
            finalLimit?: number;
            minScore?: number;
        } = {},
        tracing: HybridSearchTraceOptions = {}
    ): Promise<RankedSearchResult[]> {
        const response = await this.searchWithDiagnostics(
            collectionName,
            query,
            options,
            tracing
        );
        return response.results;
    }
}
