import { Module } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { HealthModule } from "./health/health.module";
import { UserModule } from "./user/user.module";

@Module({
    imports: [DatabaseModule, HealthModule, AuthModule, UserModule],
    controllers: [AppController],
})
export class AppModule {}
