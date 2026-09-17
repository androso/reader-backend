import { Module } from "@nestjs/common";
import { DRIZZLE, type Database } from "../database/database.module";
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
    ],
})
export class ChatModule {}
