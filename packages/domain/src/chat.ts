export type ChatResourceType = "book";

export type ChatRole = "user" | "assistant";

export type ChatFinishStatus =
    | "complete"
    | "truncated"
    | "cancelled"
    | "failed";

export type ChatRetrievalStatus =
    | "ready"
    | "not_found"
    | "processing"
    | "ingestion_failed"
    | "retrieval_unavailable";

export interface ChatHighlight {
    sourceType: "epub";
    text: string;
}

export interface ChatPromptMessage {
    role: ChatRole | "system";
    content: string;
}

export interface ChatSourceMetadata {
    chapterTitle?: string;
    chapterIndex?: number;
    pageNumber?: number;
    blockIndex?: number;
}

export interface ChatSource {
    id: string;
    chunkIndex: number;
    score: number;
    bestRank: number;
    rerankerRank?: number;
    rerankerScore?: number;
    selectionReason?: string;
    excerpt: string;
    metadata?: ChatSourceMetadata | null;
}

export interface ChatMessage {
    id: string;
    conversationId: string;
    role: ChatRole;
    content: string;
    contextSources: ChatSource[] | null;
    completionStatus: ChatFinishStatus | null;
    finishReason: string | null;
    createdAt: Date;
}

export interface ChatConversation {
    id: string;
    userId: string;
    title: string;
    createdAt: Date;
    lastMessageAt: Date;
    resourceType: ChatResourceType;
    resourceId: string;
}

export interface ChatHybridSearchCandidateDiagnostic {
    id: string;
    rank: number;
    score?: number;
    distance?: number;
}

export interface ChatHybridSearchDiagnostics {
    mode: "hybrid" | "vector_only";
    durationMs: number;
    lexicalCandidates: ChatHybridSearchCandidateDiagnostic[];
    vectorCandidates: ChatHybridSearchCandidateDiagnostic[];
    selectedCandidates: ChatHybridSearchCandidateDiagnostic[];
}

export interface ChatRerankedCandidateDiagnostic {
    id: string;
    firstStageRank: number;
    chunkIndex: number;
    origin: "first_stage" | "neighbor";
    neighborOf?: string;
}

export interface ChatRerankedFinalCandidateDiagnostic
    extends ChatRerankedCandidateDiagnostic {
    rank: number;
    rerankerRank?: number;
    rerankerScore?: number;
    selectionReason: string;
    maxWordTrigramJaccard: number;
}

export interface ChatModelUsage {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface ChatModelCost {
    currency: "USD";
    amount: number;
    pricingVersion: string;
    sourceUrl: string;
}

export interface ChatRerankedRetrievalDiagnostics {
    mode: "reranked";
    durationMs: number;
    firstStage: ChatHybridSearchDiagnostics;
    firstStageCandidates: ChatRerankedCandidateDiagnostic[];
    finalCandidates: ChatRerankedFinalCandidateDiagnostic[];
    reranker: {
        requestedModel: string;
        resolvedModel: string | null;
        promptVersion: string;
        status: "success" | "skipped" | "fallback";
        durationMs: number;
        usage: ChatModelUsage | null;
        estimatedCost: ChatModelCost | null;
        fallbackReason: string | null;
    };
    diversity: { maxWordTrigramJaccard: number };
}

export type ChatRagRetrievalDiagnostics =
    | ChatHybridSearchDiagnostics
    | ChatRerankedRetrievalDiagnostics;

export interface ChatRetrievalDiagnostics {
    pipelineVersion: string;
    promptVersion: string;
    queryPlan: null;
    retrieval: ChatRagRetrievalDiagnostics | null;
}

export interface ChatGenerationResult {
    answer: string;
    modelVersion: string;
    finishReason: string | null;
    streamCompleted: boolean;
    usage: Record<string, unknown> | null;
    durationMs: number;
    transportWarning?: string;
}

export type ChatStreamEvent =
    | { type: "conversation_id"; conversationId: string }
    | { content: string }
    | { type: "sources"; sources: ChatSource[] }
    | {
          type: "terminal";
          status: ChatFinishStatus;
          finishReason: string | null;
      }
    | {
          error: string;
          status?:
              | "processing"
              | "failed"
              | "not_found"
              | "retrieval_unavailable";
      };

export const normalizeChatMessage = (message: unknown): string | null => {
    if (typeof message !== "string") return null;

    const content = message.trim();
    return content.length > 0 && content.length <= 8_000 ? content : null;
};

export const getSubmittedUserMessage = (body: unknown): string | null => {
    if (!body || typeof body !== "object") return null;

    const { message } = body as { message?: unknown };
    return normalizeChatMessage(message);
};

export interface ChatHistoryMessage {
    role: ChatRole;
    content: string;
}

export const selectHistoryWindow = (
    messages: ChatHistoryMessage[]
): ChatHistoryMessage[] => {
    const bounded: ChatHistoryMessage[] = [];
    let characters = 0;
    for (const message of messages.slice(-30).reverse()) {
        if (characters + message.content.length > 60_000) break;
        bounded.push(message);
        characters += message.content.length;
    }
    return bounded.reverse().map((message) => ({
        role: message.role,
        content: message.content,
    }));
};

export const HIGHLIGHT_CONTEXT_MAX_CHARS = 4000;

export const normalizeEpubHighlight = (
    value: unknown
): ChatHighlight | null => {
    if (!value || typeof value !== "object") return null;

    const candidate = value as {
        sourceType?: unknown;
        text?: unknown;
    };
    if (candidate.sourceType !== "epub" || typeof candidate.text !== "string") {
        return null;
    }

    const text = candidate.text.trim();
    if (!text) return null;

    return {
        sourceType: "epub",
        text: text.slice(0, HIGHLIGHT_CONTEXT_MAX_CHARS),
    };
};

export const mapFinishReason = (
    finishReason: string | null
): Exclude<ChatFinishStatus, "cancelled"> =>
    finishReason === "stop"
        ? "complete"
        : finishReason === "length"
          ? "truncated"
          : "failed";

export class ChatValidationError extends Error {
    constructor(
        readonly code: string,
        message: string
    ) {
        super(message);
        this.name = "ChatValidationError";
    }
}

export class ChatResourceNotFoundError extends Error {
    constructor(message = "Book not found") {
        super(message);
        this.name = "ChatResourceNotFoundError";
    }
}

export class ChatResourceAccessDeniedError extends Error {
    constructor(message = "Book access denied") {
        super(message);
        this.name = "ChatResourceAccessDeniedError";
    }
}

export class ChatConversationNotFoundError extends Error {
    constructor(message = "Conversation not found") {
        super(message);
        this.name = "ChatConversationNotFoundError";
    }
}

export class ChatCancelledError extends Error {
    constructor(message = "Chat cancelled") {
        super(message);
        this.name = "ChatCancelledError";
    }
}
