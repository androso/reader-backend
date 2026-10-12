import { Module } from "@nestjs/common";
import { SessionModule } from "../auth/session.module";
import {
    AppendBookChat,
    GetBookConversation,
    ListBookConversations,
    RunBookChat,
    StartBookChat,
} from "@reader/application";
import { DRIZZLE, type Database } from "../database/database.module";
import {
    createChatResourceAccess,
    createDrizzleChatConversationRepository,
    createDrizzleChatMessageRepository,
    createChatClock,
    createChatExecutionMetadataBuilder,
    createChatGeneration,
    createChatModelResolver,
    createChatRetrieval,
    createChatShadowScheduler,
    createChatTracing,
} from "../infrastructure/chat";
import {
    CHAT_CONVERSATION_REPOSITORY,
    CHAT_MESSAGE_REPOSITORY,
    CHAT_RESOURCE_ACCESS,
    GET_BOOK_CONVERSATION,
    LIST_BOOK_CONVERSATIONS,
    APPEND_BOOK_CHAT,
    CHAT_CLOCK,
    CHAT_GENERATION,
    CHAT_METADATA,
    CHAT_MODEL_RESOLVER,
    CHAT_RETRIEVAL,
    CHAT_SHADOW,
    CHAT_TRACING,
    RUN_BOOK_CHAT,
    START_BOOK_CHAT,
} from "../infrastructure/chat/chat.tokens";
import { ChatController } from "./chat.controller";
import {
    CHAT_OPERATIONS,
    createChatOperations,
    defaultChatStreamDependencies,
} from "./chat-stream";

@Module({
    imports: [SessionModule],
    controllers: [ChatController],
    providers: [
        {
            provide: CHAT_OPERATIONS,
            useFactory: (db: Database) =>
                createChatOperations({
                    ...defaultChatStreamDependencies,
                    db,
                }),
            inject: [DRIZZLE],
        },
        {
            provide: CHAT_CLOCK,
            useFactory: createChatClock,
        },
        {
            provide: CHAT_MODEL_RESOLVER,
            useFactory: createChatModelResolver,
        },
        {
            provide: CHAT_RETRIEVAL,
            useFactory: createChatRetrieval,
        },
        {
            provide: CHAT_GENERATION,
            useFactory: createChatGeneration,
        },
        {
            provide: CHAT_TRACING,
            useFactory: createChatTracing,
        },
        {
            provide: CHAT_SHADOW,
            useFactory: createChatShadowScheduler,
        },
        {
            provide: CHAT_METADATA,
            useFactory: createChatExecutionMetadataBuilder,
        },
        {
            provide: RUN_BOOK_CHAT,
            useFactory: (
                retrieval: ConstructorParameters<
                    typeof RunBookChat
                >[0]["retrieval"],
                generation: ConstructorParameters<
                    typeof RunBookChat
                >[0]["generation"],
                messages: ConstructorParameters<
                    typeof RunBookChat
                >[0]["messages"],
                conversations: ConstructorParameters<
                    typeof RunBookChat
                >[0]["conversations"],
                tracing: ConstructorParameters<
                    typeof RunBookChat
                >[0]["tracing"],
                shadow: ConstructorParameters<typeof RunBookChat>[0]["shadow"],
                metadata: ConstructorParameters<
                    typeof RunBookChat
                >[0]["metadata"],
                clock: ConstructorParameters<typeof RunBookChat>[0]["clock"]
            ) =>
                new RunBookChat({
                    retrieval,
                    generation,
                    messages,
                    conversations,
                    tracing,
                    shadow,
                    metadata,
                    clock,
                }),
            inject: [
                CHAT_RETRIEVAL,
                CHAT_GENERATION,
                CHAT_MESSAGE_REPOSITORY,
                CHAT_CONVERSATION_REPOSITORY,
                CHAT_TRACING,
                CHAT_SHADOW,
                CHAT_METADATA,
                CHAT_CLOCK,
            ],
        },
        {
            provide: START_BOOK_CHAT,
            useFactory: (
                resourceAccess: ConstructorParameters<
                    typeof StartBookChat
                >[0]["resourceAccess"],
                conversations: ConstructorParameters<
                    typeof StartBookChat
                >[0]["conversations"],
                messages: ConstructorParameters<
                    typeof StartBookChat
                >[0]["messages"],
                modelResolver: ConstructorParameters<
                    typeof StartBookChat
                >[0]["modelResolver"],
                runner: ConstructorParameters<
                    typeof StartBookChat
                >[0]["runner"],
                clock: ConstructorParameters<typeof StartBookChat>[0]["clock"]
            ) =>
                new StartBookChat({
                    resourceAccess,
                    conversations,
                    messages,
                    modelResolver,
                    runner,
                    clock,
                }),
            inject: [
                CHAT_RESOURCE_ACCESS,
                CHAT_CONVERSATION_REPOSITORY,
                CHAT_MESSAGE_REPOSITORY,
                CHAT_MODEL_RESOLVER,
                RUN_BOOK_CHAT,
                CHAT_CLOCK,
            ],
        },
        {
            provide: APPEND_BOOK_CHAT,
            useFactory: (
                resourceAccess: ConstructorParameters<
                    typeof AppendBookChat
                >[0]["resourceAccess"],
                conversations: ConstructorParameters<
                    typeof AppendBookChat
                >[0]["conversations"],
                messages: ConstructorParameters<
                    typeof AppendBookChat
                >[0]["messages"],
                modelResolver: ConstructorParameters<
                    typeof AppendBookChat
                >[0]["modelResolver"],
                runner: ConstructorParameters<
                    typeof AppendBookChat
                >[0]["runner"],
                clock: ConstructorParameters<typeof AppendBookChat>[0]["clock"]
            ) =>
                new AppendBookChat({
                    resourceAccess,
                    conversations,
                    messages,
                    modelResolver,
                    runner,
                    clock,
                }),
            inject: [
                CHAT_RESOURCE_ACCESS,
                CHAT_CONVERSATION_REPOSITORY,
                CHAT_MESSAGE_REPOSITORY,
                CHAT_MODEL_RESOLVER,
                RUN_BOOK_CHAT,
                CHAT_CLOCK,
            ],
        },
        {
            provide: CHAT_CONVERSATION_REPOSITORY,
            useFactory: (db: Database) =>
                createDrizzleChatConversationRepository(db),
            inject: [DRIZZLE],
        },
        {
            provide: CHAT_MESSAGE_REPOSITORY,
            useFactory: (db: Database) =>
                createDrizzleChatMessageRepository(db),
            inject: [DRIZZLE],
        },
        {
            provide: CHAT_RESOURCE_ACCESS,
            useFactory: (db: Database) => createChatResourceAccess(db),
            inject: [DRIZZLE],
        },
        {
            provide: LIST_BOOK_CONVERSATIONS,
            useFactory: (
                resourceAccess: ConstructorParameters<
                    typeof ListBookConversations
                >[0]["resourceAccess"],
                conversations: ConstructorParameters<
                    typeof ListBookConversations
                >[0]["conversations"]
            ) => new ListBookConversations({ resourceAccess, conversations }),
            inject: [CHAT_RESOURCE_ACCESS, CHAT_CONVERSATION_REPOSITORY],
        },
        {
            provide: GET_BOOK_CONVERSATION,
            useFactory: (
                resourceAccess: ConstructorParameters<
                    typeof GetBookConversation
                >[0]["resourceAccess"],
                conversations: ConstructorParameters<
                    typeof GetBookConversation
                >[0]["conversations"],
                messages: ConstructorParameters<
                    typeof GetBookConversation
                >[0]["messages"]
            ) =>
                new GetBookConversation({
                    resourceAccess,
                    conversations,
                    messages,
                }),
            inject: [
                CHAT_RESOURCE_ACCESS,
                CHAT_CONVERSATION_REPOSITORY,
                CHAT_MESSAGE_REPOSITORY,
            ],
        },
    ],
})
export class ChatModule {}
