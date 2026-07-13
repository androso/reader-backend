import { ChromaClient, type IEmbeddingFunction } from "chromadb";
import OpenAI from "openai";
import { createLogger } from "./logger";

const log = createLogger("chroma");
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-ada-002";
const DEFAULT_COLLECTION_CACHE_MAX_ENTRIES = 100;
type ChromaCollectionClient = Pick<
    ChromaClient,
    "createCollection" | "deleteCollection" | "getCollection"
>;

const precomputedEmbeddingFunction: IEmbeddingFunction = {
    async generate() {
        throw new Error(
            "Embeddings are generated before Chroma calls in ChromaVectorStore"
        );
    },
};

export interface VectorStoreProvider {
    createCollection(name: string): Promise<any>;
    getOrCreateCollection(name: string): Promise<any>;
    addDocuments(collectionName: string, documents: string[]): Promise<void>;
    queryCollection(
        collectionName: string,
        query: string,
        nResults?: number
    ): Promise<any>;
    searchDocuments(
        collectionName: string,
        query: string,
        nResults?: number
    ): Promise<VectorSearchResult[]>;
    deleteCollection(name: string): Promise<boolean>;
    resetCollection(name: string): Promise<void>;
    getCollection(name: string): Promise<any | null>;
}

export interface VectorSearchResult {
    id: string;
    content: string;
    rank: number;
    distance?: number;
}

const parsePositiveIntegerEnv = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
};

const sleep = (delayMs: number) =>
    new Promise((resolve) => setTimeout(resolve, delayMs));

const getErrorDetail = (error: unknown) => {
    if (!error || typeof error !== "object") {
        return String(error);
    }

    const details = error as {
        code?: unknown;
        errno?: unknown;
        status?: unknown;
        type?: unknown;
        message?: unknown;
        name?: unknown;
    };

    return [
        details.name,
        details.code,
        details.errno,
        details.status,
        details.type,
        details.message,
    ]
        .filter(Boolean)
        .join(" ");
};

const isRetryableVectorStoreError = (error: unknown) => {
    const detail = getErrorDetail(error);

    return [
        "ERR_STREAM_PREMATURE_CLOSE",
        "Premature close",
        "Invalid response body",
        "ECONNRESET",
        "ETIMEDOUT",
        "ENOTFOUND",
        "EAI_AGAIN",
        "ECONNREFUSED",
        "APIConnectionError",
        "APIConnectionTimeoutError",
        "429",
        "500",
        "502",
        "503",
        "504",
    ].some((retryable) => detail.includes(retryable));
};

const isCollectionNotFoundError = (error: unknown) => {
    if (!error || typeof error !== "object") return false;

    const details = error as {
        code?: unknown;
        message?: unknown;
        name?: unknown;
        status?: unknown;
    };
    return (
        details.name === "ChromaNotFoundError" ||
        details.code === 404 ||
        details.code === "404" ||
        details.status === 404 ||
        details.status === "404" ||
        (typeof details.message === "string" &&
            details.message.toLowerCase().includes("not found"))
    );
};

const withRetry = async <T>(
    operation: () => Promise<T>,
    {
        attempts,
        delayMs,
        label,
    }: { attempts: number; delayMs: number; label: string }
) => {
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            if (attempt >= attempts || !isRetryableVectorStoreError(error)) {
                throw error;
            }

            const retryDelayMs = delayMs * 2 ** (attempt - 1);
            log.warn("Retryable vector operation failed", {
                label,
                attempt,
                attempts,
                retryDelayMs,
                error: getErrorDetail(error),
            });
            await sleep(retryDelayMs);
        }
    }

    throw lastError;
};

export class ChromaVectorStore implements VectorStoreProvider {
    private readonly client: ChromaCollectionClient;
    private readonly openai: OpenAI;
    private readonly embeddingModel: string;
    private readonly collections = new Map<
        string,
        { name: string; collection: any; lastAccessed: number }
    >();

    constructor(client?: ChromaCollectionClient) {
        this.client =
            client ??
            new ChromaClient({
                path: process.env.CHROMA_URL || "http://localhost:8000",
                auth: {
                    provider: "basic",
                    credentials:
                        process.env.CHROMA_CLIENT_AUTH_CREDENTIALS || "",
                },
            });

        this.embeddingModel =
            process.env.OPENAI_EMBEDDING_MODEL ||
            DEFAULT_OPENAI_EMBEDDING_MODEL;

        const openAiOptions: NonNullable<
            ConstructorParameters<typeof OpenAI>[0]
        > = {
            apiKey: process.env.OPENAI_API_KEY || "",
            maxRetries: 0,
            defaultHeaders: {
                "Accept-Encoding": "identity",
            },
        };

        if (typeof globalThis.fetch === "function") {
            openAiOptions.fetch = globalThis.fetch.bind(
                globalThis
            ) as NonNullable<typeof openAiOptions.fetch>;
        }

        this.openai = new OpenAI(openAiOptions);

        log.info("Initialized Chroma vector store", {
            chromaUrl: process.env.CHROMA_URL || "http://localhost:8000",
            embeddingModel: this.embeddingModel,
            embeddingFetch:
                typeof globalThis.fetch === "function"
                    ? "globalThis.fetch"
                    : "openai-sdk-default",
            embeddingAcceptEncoding: "identity",
        });

        setInterval(() => this.cleanUpCache(), 1800000).unref();
    }

    private cleanUpCache(): void {
        const now = Date.now();
        const cacheTtl = 3600000;
        for (const [name, data] of this.collections.entries()) {
            if (now - data.lastAccessed > cacheTtl) {
                this.collections.delete(name);
            }
        }
        const maxEntries = parsePositiveIntegerEnv(
            "CHROMA_COLLECTION_CACHE_MAX_ENTRIES",
            DEFAULT_COLLECTION_CACHE_MAX_ENTRIES
        );
        while (this.collections.size > maxEntries) {
            const oldest = [...this.collections.entries()].sort(
                (left, right) => left[1].lastAccessed - right[1].lastAccessed
            )[0];
            if (!oldest) break;
            this.collections.delete(oldest[0]);
        }
    }

    async getCollection(name: string) {
        log.debug("Fetching collection", { name, source: "cache" });
        try {
            const cachedCollection = this.collections.get(name);
            if (cachedCollection) {
                cachedCollection.lastAccessed = Date.now();
                log.debug("Collection cache hit", { name });
                return cachedCollection.collection;
            }

            log.info("Fetching collection from Chroma", { name });
            const collection = await this.client.getCollection({
                name,
                embeddingFunction: precomputedEmbeddingFunction,
            });

            this.collections.set(name, {
                name,
                collection,
                lastAccessed: Date.now(),
            });
            log.info("Collection loaded from Chroma", { name });
            return collection;
        } catch (error) {
            if (!isCollectionNotFoundError(error)) throw error;
            log.debug("Collection not found in Chroma", {
                name,
                error: getErrorDetail(error),
            });
            return null;
        }
    }

    async createCollection(name: string): Promise<any> {
        log.info("Creating Chroma collection", { name });
        const collection = await this.client.createCollection({
            name,
            embeddingFunction: precomputedEmbeddingFunction,
        });
        this.collections.set(name, {
            name,
            collection,
            lastAccessed: Date.now(),
        });
        log.info("Chroma collection created", { name });
        return collection;
    }

    async getOrCreateCollection(name: string): Promise<any> {
        log.debug("Resolving collection", { name });
        const existingCollection = await this.getCollection(name);
        if (existingCollection) return existingCollection;
        log.info("Collection does not exist, creating", { name });
        return this.createCollection(name);
    }

    async resetCollection(name: string) {
        log.info("Resetting collection", { name });
        try {
            await this.client.deleteCollection({ name });
            log.info("Deleted existing collection for reset", { name });
        } catch (error) {
            if (!isCollectionNotFoundError(error)) throw error;
            log.debug("No existing collection to delete during reset", {
                name,
                error: getErrorDetail(error),
            });
        }
        this.collections.delete(name);
        await this.createCollection(name);
        log.info("Collection reset complete", { name });
    }

    async addDocuments(collectionName: string, documents: string[]) {
        const start = Date.now();
        log.info("Adding documents to collection", {
            collectionName,
            documentCount: documents.length,
        });
        const collection = await this.getOrCreateCollection(collectionName);
        const validDocuments = documents.filter(
            (doc) => doc && doc.length > 0 && doc.length < 4000
        );
        const invalidCount = documents.length - validDocuments.length;
        if (invalidCount > 0) {
            log.warn("Filtered invalid documents", {
                collectionName,
                invalidCount,
                totalCount: documents.length,
            });
        }

        const batchSize = parsePositiveIntegerEnv(
            "VECTOR_STORE_BATCH_SIZE",
            50
        );
        const concurrentBatches = parsePositiveIntegerEnv(
            "VECTOR_STORE_CONCURRENT_BATCHES",
            2
        );
        const batchRetryAttempts = parsePositiveIntegerEnv(
            "VECTOR_STORE_BATCH_RETRY_ATTEMPTS",
            4
        );
        const batchRetryDelayMs = parsePositiveIntegerEnv(
            "VECTOR_STORE_BATCH_RETRY_DELAY_MS",
            1000
        );

        log.info("Upsert configuration", {
            collectionName,
            batchSize,
            concurrentBatches,
            batchRetryAttempts,
            batchRetryDelayMs,
            validDocumentCount: validDocuments.length,
        });

        const allBatches = [];

        for (let i = 0; i < validDocuments.length; i += batchSize) {
            const batchDocuments = validDocuments.slice(i, i + batchSize);
            allBatches.push({
                ids: batchDocuments.map(
                    (_, idx) => `${collectionName}_${i + idx}`
                ),
                documents: batchDocuments,
                metadatas: batchDocuments.map((_, idx) => ({
                    collectionName,
                    chunkIndex: i + idx,
                })),
            });
        }

        log.info("Starting batched upsert", {
            collectionName,
            batchCount: allBatches.length,
            totalDocuments: validDocuments.length,
        });

        for (let i = 0; i < allBatches.length; i += concurrentBatches) {
            const batchGroup = allBatches.slice(i, i + concurrentBatches);
            log.debug("Upserting batch group", {
                collectionName,
                groupIndex: i,
                groupSize: batchGroup.length,
            });
            await Promise.all(
                batchGroup.map((batchData, batchIndex) =>
                    this.upsertBatch(collection, batchData, {
                        collectionName,
                        batchIndex: i + batchIndex,
                        attempts: batchRetryAttempts,
                        delayMs: batchRetryDelayMs,
                    }).then(() => {
                        log.debug("Batch upsert succeeded", {
                            collectionName,
                            batchIndex: i + batchIndex,
                            documentsInBatch: batchData.documents.length,
                        });
                    })
                )
            );
        }

        const duration = Date.now() - start;
        log.info("Documents added to collection", {
            collectionName,
            documentCount: validDocuments.length,
            durationMs: duration,
        });
    }

    private async upsertBatch(
        collection: any,
        batchData: {
            ids: string[];
            documents: string[];
            metadatas: { collectionName: string; chunkIndex: number }[];
        },
        {
            collectionName,
            batchIndex,
            attempts,
            delayMs,
        }: {
            collectionName: string;
            batchIndex: number;
            attempts: number;
            delayMs: number;
        }
    ) {
        const embeddings = await withRetry(
            () =>
                this.createEmbeddings(batchData.documents, {
                    collectionName,
                    batchIndex,
                }),
            {
                attempts,
                delayMs,
                label: `OpenAI embeddings for ${collectionName} batch ${batchIndex}`,
            }
        );

        await withRetry(
            () =>
                collection.upsert({
                    ...batchData,
                    embeddings,
                }),
            {
                attempts,
                delayMs,
                label: `Chroma upsert for ${collectionName} batch ${batchIndex}`,
            }
        );
    }

    private async createEmbeddings(
        input: string[],
        context: { collectionName: string; batchIndex?: number }
    ): Promise<number[][]> {
        const start = Date.now();
        log.info("Creating OpenAI embeddings", {
            ...context,
            inputCount: input.length,
            model: this.embeddingModel,
        });

        const { data: response, request_id: requestId } =
            await this.openai.embeddings
                .create({
                    model: this.embeddingModel,
                    input,
                    encoding_format: "float",
                })
                .withResponse();

        const embeddings = response.data.map(
            (item: { embedding: number[] }) => item.embedding
        );
        if (embeddings.length !== input.length) {
            throw new Error(
                `OpenAI returned ${embeddings.length} embeddings for ${input.length} inputs`
            );
        }

        log.info("OpenAI embeddings created", {
            ...context,
            inputCount: input.length,
            requestId,
            promptTokens: response.usage?.prompt_tokens,
            totalTokens: response.usage?.total_tokens,
            durationMs: Date.now() - start,
        });

        return embeddings;
    }

    async queryCollection(collectionName: string, query: string, nResults = 3) {
        const start = Date.now();
        log.info("Querying collection", { collectionName, nResults });
        log.debug("Query text", { collectionName, query: query.slice(0, 200) });
        const collection = await this.getOrCreateCollection(collectionName);
        const [queryEmbedding] = await this.createEmbeddings([query], {
            collectionName,
            batchIndex: 0,
        });
        const results = await collection.query({
            queryEmbeddings: [queryEmbedding],
            nResults,
        });
        const duration = Date.now() - start;
        const resultCount = results.ids?.[0]?.length ?? 0;
        log.info("Collection query complete", {
            collectionName,
            nResults,
            resultCount,
            durationMs: duration,
        });
        log.debug("Query results", {
            collectionName,
            distances: results.distances?.[0],
        });
        return results;
    }

    async searchDocuments(
        collectionName: string,
        query: string,
        nResults = 20
    ): Promise<VectorSearchResult[]> {
        const start = Date.now();
        log.info("Searching documents", { collectionName, nResults });
        const results = await this.queryCollection(
            collectionName,
            query,
            nResults
        );
        const ids = results.ids?.[0] || [];
        const documents = results.documents?.[0] || [];
        const distances = results.distances?.[0] || [];

        const mapped = documents
            .map((content: string | null, index: number) => {
                if (!content) return null;
                return {
                    id: ids[index] || `${collectionName}_${index}`,
                    content,
                    rank: index + 1,
                    distance: distances[index],
                };
            })
            .filter(Boolean) as VectorSearchResult[];

        const duration = Date.now() - start;
        log.info("Document search complete", {
            collectionName,
            nResults,
            returnedCount: mapped.length,
            durationMs: duration,
        });
        return mapped;
    }

    async deleteCollection(name: string): Promise<boolean> {
        log.info("Deleting collection", { name });
        await this.client.deleteCollection({ name });
        this.collections.delete(name);
        log.info("Collection deleted", { name });
        return true;
    }
}

export const vectorStore: VectorStoreProvider = new ChromaVectorStore();
