import type {
    ChatSource,
    RagCandidate,
    RagChunk,
    RagLexicalResult,
    RagRankedResult,
    RagRerankerResult,
    RagShadowResult,
    RagVectorResult,
} from "@reader/domain";
import type { Clock } from "../chat/ports";

export type { Clock } from "../chat/ports";

export interface OwnedBookLookup {
    findOwned(input: { userId: string; bookId: string }): Promise<{
        id: string;
        userId: string;
        collectionName: string | null;
        processingStatus: string;
        processingError?: string | null;
    } | null>;
}

export interface BookChunkReader {
    getCollectionChunks(collectionName: string): Promise<RagChunk[]>;
}

export interface LexicalSearch {
    search(
        collectionName: string,
        query: string,
        limit: number
    ): Promise<RagLexicalResult[]>;
    clearCollectionCache?(collectionName: string): void;
}

export interface VectorSearch {
    search(
        collectionName: string,
        query: string,
        limit: number
    ): Promise<RagVectorResult[]>;
}

export interface Reranker {
    rerank(input: {
        query: string;
        documents: RagCandidate[];
        topN: number;
        signal?: AbortSignal;
    }): Promise<RagRerankerResult>;
}

export type RagAnswerModelChunk = {
    delta: string;
    finishReason: string | null;
    usage: Record<string, unknown> | null;
    resolvedModel: string;
};

export type RagStreamFailureKind =
    | "provider_error"
    | "timeout"
    | "cancelled"
    | "premature_close";

export interface RagStreamFailure {
    kind: RagStreamFailureKind;
    message: string;
}

export interface AnswerModelStream {
    stream(input: {
        messages: Array<{
            role: "user" | "assistant" | "system";
            content: string;
        }>;
        model: string;
        signal?: AbortSignal;
    }): AsyncIterable<RagAnswerModelChunk>;
}

export interface RagShadowJob {
    userId: string;
    conversationId: string;
    bookId: string;
    assistantMessageId: string;
}

export interface RagShadowRecords {
    assistant: {
        id: string;
        role: "user" | "assistant";
        conversationId: string;
        contextSources: ChatSource[] | null;
        executionMetadata: Record<string, unknown> | null;
    } | null;
    userMessage: {
        id: string;
        role: "user" | "assistant";
        conversationId: string;
        content: string;
    } | null;
    conversation: {
        id: string;
        userId: string;
        resourceType: "book" | "article";
        resourceId: string;
    } | null;
    book: { id: string; userId: string } | null;
}

export interface ShadowRepository {
    load(payload: RagShadowJob): Promise<RagShadowRecords>;
    persist(
        assistantMessageId: string,
        result: RagShadowResult
    ): Promise<boolean>;
}

export interface RagTracing {
    traceId?: string;
    startObservation(
        name: string,
        attributes?: Record<string, unknown>
    ): RagTracing;
    update(attributes: Record<string, unknown>): void;
    end(): void;
    setTraceIO?(attributes: Record<string, unknown>): void;
}
