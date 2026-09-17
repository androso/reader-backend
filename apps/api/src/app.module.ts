import { Module } from "@nestjs/common";
import { RateLimitModule } from "./common/rate-limit.module";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { BooksModule } from "./books/books.module";
import { ChatModule } from "./chat/chat.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { TrackerModule } from "./tracker/tracker.module";
import { UserModule } from "./user/user.module";

@Module({
    imports: [
        DatabaseModule,
        RateLimitModule,
        HealthModule,
        AuthModule,
        UserModule,
        BooksModule,
        ChatModule,
        TrackerModule,
    ],
    controllers: [AppController],
})
export class AppModule {}
