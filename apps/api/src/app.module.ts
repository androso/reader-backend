import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { BooksModule } from "./books/books.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { TrackerModule } from "./tracker/tracker.module";
import { UserModule } from "./user/user.module";

@Module({
    imports: [
        DatabaseModule,
        HealthModule,
        AuthModule,
        UserModule,
        BooksModule,
        TrackerModule,
    ],
    controllers: [AppController],
})
export class AppModule {}
