import { HttpException } from "@nestjs/common";
import { EventEmitter } from "node:events";
import type { Response } from "express";
import type { Request } from "express";
import {
    AppendBookChat,
    RunBookChat,
    StartBookChat,
} from "@reader/application";
import { mapFinishReason, type ChatPromptMessage } from "@reader/domain";
import {
    createChatResourceAccess,
    createDrizzleChatConversationRepository,
    createDrizzleChatMessageRepository,
    createDrizzleChatResourceRepository,
} from "../infrastructure/chat";
import {
    createChatClock,
    createChatExecutionMetadataBuilder,
    createChatGeneration,
    createChatModelResolver,
    createChatRetrieval,
    createChatShadowScheduler,
    createChatTracing,
} from "../infrastructure/chat/chatAdapters";
import {
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} from "@reader/domain";
import { createSseChatSession } from "../infrastructure/chat/sseChatSession";
import type { Database } from "../database/database.module";
import { db } from "../db";
import {
    generateBookAnswer,
    retrieveBookContext,
} from "../services/BookRagService";
import { authorizeChatResource } from "../services/ChatResourceAuthorization";
import {
    getNoopTraceObservation,
    recordObservationError,
    withBookChatTrace,
    type TraceObservation,
} from "../observability/langfuse";
import { maybeEnqueueRagRerankShadow } from "../services/RagShadowEnqueueService";
import { type OpenAIChatModel } from "../services/OpenAIServices";
import type { HighlightContext } from "../services/HighlightContext";

export { mapFinishReason } from "@reader/domain";

export const CHAT_OPERATIONS = "CHAT_OPERATIONS";

export const createChatResourceRepository = createDrizzleChatResourceRepository;
export type ChatResourceRepository = ReturnType<
    typeof createChatResourceRepository
>;

export interface ChatStreamDependencies {
    db: Database;
    repository?: ChatResourceRepository;
    authorizeChatResource: typeof authorizeChatResource;
    retrieveBookContext: typeof retrieveBookContext;
    generateBookAnswer: typeof generateBookAnswer;
    maybeEnqueueRagRerankShadow: typeof maybeEnqueueRagRerankShadow;
    withBookChatTrace: typeof withBookChatTrace;
    getNoopTraceObservation: typeof getNoopTraceObservation;
    recordObservationError: typeof recordObservationError;
}

const chatModelResolver = createChatModelResolver();
export const resolveChatModel = (model: unknown): OpenAIChatModel | null =>
    chatModelResolver.resolve(model) as OpenAIChatModel | null;

const createLegacyRunner = (
    deps: ChatStreamDependencies,
    resourceAccess = createChatResourceAccess(deps.db)
) => {
    const conversations = createDrizzleChatConversationRepository(deps.db);
    const messages = createDrizzleChatMessageRepository(deps.db);
    const runner = new RunBookChat({
        retrieval: createChatRetrieval(deps.retrieveBookContext),
        generation: createChatGeneration(
            deps.generateBookAnswer,
            deps.recordObservationError
        ),
        messages,
        conversations,
        tracing: createChatTracing(deps.withBookChatTrace),
        shadow: createChatShadowScheduler(deps.maybeEnqueueRagRerankShadow),
        metadata: createChatExecutionMetadataBuilder(),
        clock: createChatClock(),
    });
    const modelResolver = createChatModelResolver();
    const clock = createChatClock();
    return {
        runner,
        startBookChat: new StartBookChat({
            resourceAccess,
            conversations,
            messages,
            modelResolver,
            clock,
            runner,
        }),
        appendBookChat: new AppendBookChat({
            resourceAccess,
            conversations,
            messages,
            modelResolver,
            clock,
            runner,
        }),
    };
};

export const createChatOperations = (deps: ChatStreamDependencies) => {
    const chatResourceRepository =
        deps.repository ?? createChatResourceRepository(deps.db);
    const resourceAccess = createChatResourceAccess(
        deps.db,
        chatResourceRepository
    );
    const conversations = createDrizzleChatConversationRepository(deps.db);
    const messages = createDrizzleChatMessageRepository(deps.db);
    const { runner, startBookChat, appendBookChat } = createLegacyRunner(
        deps,
        resourceAccess
    );

    const authorizeRequestResource = async ({
        resourceType,
        resourceId,
        userId,
    }: {
        resourceType: string;
        resourceId: string;
        userId: string;
    }) => {
        try {
            const authorization = await resourceAccess.authorize({
                resourceType,
                resourceId,
                userId,
            });
            return {
                ok: true as const,
                resourceType: authorization.resourceType,
            };
        } catch (error) {
            if (error instanceof ChatValidationError)
                throw new HttpException({ error: error.message }, 400);
            if (error instanceof ChatResourceNotFoundError)
                throw new HttpException({ error: error.message }, 404);
            if (error instanceof ChatResourceAccessDeniedError)
                throw new HttpException({ error: error.message }, 403);
            throw error;
        }
    };

    const runChatCompletion = async (input: {
        resourceType: string;
        resourceId: string;
        conversationId: string;
        userId: string;
        messages: ChatPromptMessage[];
        query: string;
        res: Response;
        routeName: string;
        model: OpenAIChatModel;
        highlightContext: HighlightContext | null;
        trace: TraceObservation;
        signal?: AbortSignal;
        userMessageId: string;
    }) => {
        const req = new EventEmitter() as Request;
        const session = createSseChatSession(req, input.res);
        const abortSession = () => req.emit("aborted");
        input.signal?.addEventListener("abort", abortSession, { once: true });
        if (input.signal?.aborted) abortSession();
        try {
            if (!session.signal.aborted) session.open();
            await runner.execute({
                userId: input.userId,
                bookId: input.resourceId,
                conversationId: input.conversationId,
                userMessageId: input.userMessageId,
                query: input.query,
                messages: input.messages,
                model: input.model,
                highlightContext: input.highlightContext,
                routeName: input.routeName,
                trace: input.trace as never,
                signal: session.signal,
                sink: session.sink,
            });
        } finally {
            input.signal?.removeEventListener("abort", abortSession);
            session.dispose();
        }
    };

    const runBookChatTraceIfNeeded = <T>(
        meta: {
            resourceType: string;
            resourceId: string;
            conversationId: string;
            userId: string;
            routeName: string;
            messageCount: number;
            queryLength: number;
            hasHighlightContext?: boolean;
        },
        fn: (trace: TraceObservation) => T
    ) => {
        if (meta.resourceType !== "book") {
            return fn(deps.getNoopTraceObservation());
        }
        return deps.withBookChatTrace(meta, fn);
    };

    return {
        chatResourceRepository,
        authorizeRequestResource,
        findScopedConversation: conversations.findScoped,
        touchConversation: async (conversationId: string) =>
            conversations.touch(conversationId, new Date()),
        loadConversationHistory: async (conversationId: string) => {
            const rows = await messages.listForConversation(conversationId);
            return rows.map(({ role, content }) => ({ role, content }));
        },
        resolveChatModel,
        runChatCompletion,
        runBookChatTraceIfNeeded,
        startBookChat,
        appendBookChat,
    };
};

export type ChatOperations = ReturnType<typeof createChatOperations>;

export const defaultChatStreamDependencies: ChatStreamDependencies = {
    db,
    authorizeChatResource,
    retrieveBookContext,
    generateBookAnswer,
    maybeEnqueueRagRerankShadow,
    withBookChatTrace,
    getNoopTraceObservation,
    recordObservationError,
};

export const defaultChatOperations = createChatOperations(
    defaultChatStreamDependencies
);

export const {
    chatResourceRepository,
    authorizeRequestResource,
    findScopedConversation,
    touchConversation,
    loadConversationHistory,
    runChatCompletion,
    runBookChatTraceIfNeeded,
} = defaultChatOperations;
