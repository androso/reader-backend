import type {
    ChatConversation,
    ChatFinishStatus,
    ChatGenerationResult,
    ChatHighlight,
    ChatMessage,
    ChatPromptMessage,
    ChatResourceType,
    ChatRetrievalDiagnostics,
    ChatRetrievalStatus,
    ChatSource,
    ChatStreamEvent,
} from "@reader/domain";

export interface AuthorizedChatResource {
    resourceType: ChatResourceType;
}

export interface ChatResourceAccess {
    authorize(input: {
        userId: string;
        resourceType: string;
        resourceId: string;
    }): Promise<AuthorizedChatResource>;
}

export interface ChatConversationRepository {
    create(input: {
        userId: string;
        title: string;
        resourceType: ChatResourceType;
        resourceId: string;
    }): Promise<Pick<ChatConversation, "id">>;
    findScoped(input: {
        conversationId: string;
        userId: string;
        resourceType: ChatResourceType;
        resourceId: string;
    }): Promise<ChatConversation | null>;
    listScoped(input: {
        userId: string;
        resourceType: ChatResourceType;
        resourceId: string;
    }): Promise<ChatConversation[]>;
    touch(conversationId: string, at: Date): Promise<void>;
}

export interface ChatMessageAppend {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    contextSources?: ChatSource[] | null;
    completionStatus?: ChatFinishStatus | null;
    finishReason?: string | null;
    executionMetadata?: Record<string, unknown> | null;
}

export interface ChatMessageRepository {
    append(message: ChatMessageAppend): Promise<ChatMessage>;
    listForConversation(conversationId: string): Promise<ChatMessage[]>;
}

export interface ChatRetrievalResult {
    status: ChatRetrievalStatus;
    messages: ChatPromptMessage[];
    sources: ChatSource[] | null;
    telemetry: ChatRetrievalDiagnostics;
    error?: string | null;
}

export interface ChatContextRetrieval {
    retrieve(
        input: {
            bookId: string;
            userId: string;
            messages: ChatPromptMessage[];
            query: string;
            highlightContext: ChatHighlight | null;
        },
        signal?: AbortSignal
    ): Promise<ChatRetrievalResult>;
}

export interface ChatAnswerGeneration {
    generate(
        input: {
            messages: ChatPromptMessage[];
            model: string;
        },
        options: {
            signal?: AbortSignal;
            onContent(chunk: string): void | Promise<void>;
        }
    ): Promise<ChatGenerationResult>;
}

export interface ChatTraceObservation {
    traceId?: string;
    setTraceIO(attributes: Record<string, unknown>): void;
    startObservation(
        name: string,
        attributes?: Record<string, unknown>
    ): ChatTraceObservation;
    update(attributes: Record<string, unknown>): void;
    end(): void;
}

export interface ChatTracing {
    run<T>(
        meta: {
            userId: string;
            conversationId: string;
            resourceType: ChatResourceType;
            resourceId: string;
            routeName: string;
            messageCount: number;
            queryLength: number;
            hasHighlightContext?: boolean;
        },
        fn: (observation: ChatTraceObservation) => Promise<T>
    ): Promise<T>;
}

export interface ChatShadowScheduler {
    maybeSchedule(input: {
        assistantMessageId: string;
        userMessageId: string;
        conversationId: string;
        bookId: string;
        userId: string;
        hasHighlightContext: boolean;
    }): Promise<void>;
}

export interface ChatEventSink {
    emit(event: ChatStreamEvent): Promise<void>;
}

export interface Clock {
    now(): Date;
}
