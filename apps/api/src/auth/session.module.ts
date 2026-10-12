import { Module } from "@nestjs/common";
import { DRIZZLE, type Database } from "../database/database.module";
import { DatabaseModule } from "../database/database.module";
import {
    createAuthenticateSession,
    loadAuthConfig,
    type AuthConfig,
} from "../infrastructure/auth";
import { AUTH_CONFIG, AUTHENTICATE_SESSION } from "./auth.tokens";
import { AuthGuard } from "../common/guards/auth.guard";

@Module({
    imports: [DatabaseModule],
    providers: [
        {
            provide: AUTH_CONFIG,
            useFactory: loadAuthConfig,
        },
        {
            provide: AUTHENTICATE_SESSION,
            useFactory: (database: Database, config: AuthConfig) =>
                createAuthenticateSession(database, config, console.error),
            inject: [DRIZZLE, AUTH_CONFIG],
        },
        AuthGuard,
    ],
    exports: [AUTHENTICATE_SESSION, AuthGuard],
})
export class SessionModule {}
