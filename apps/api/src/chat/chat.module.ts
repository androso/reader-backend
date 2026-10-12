import { Module } from "@nestjs/common";
import {
    GetBookConversation,
    ListBookConversations,
} from "@reader/application";
import { DRIZZLE, type Database } from "../database/database.module";
import {
    createChatResourceAccess,
    createDrizzleChatConversationRepository,
    createDrizzleChatMessageRepository,
} from "../infrastructure/chat";
import {
    CHAT_CONVERSATION_REPOSITORY,
    CHAT_MESSAGE_REPOSITORY,
    CHAT_RESOURCE_ACCESS,
    GET_BOOK_CONVERSATION,
    LIST_BOOK_CONVERSATIONS,
} from "../infrastructure/chat/chat.tokens";
import { ChatController } from "./chat.controller";
import {
    CHAT_OPERATIONS,
    createChatOperations,
    defaultChatStreamDependencies,
} from "./chat-stream";

@Module({
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
