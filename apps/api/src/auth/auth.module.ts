import { Module } from "@nestjs/common";
import { SignInForDevelopment, SignInWithGoogle } from "@reader/application";
import type {
    AccountRepository,
    Clock,
    DevAuthConfig,
    GoogleIdentityVerifier,
    SessionTokens,
} from "@reader/application";
import {
    DatabaseModule,
    DRIZZLE,
    type Database,
} from "../database/database.module";
import {
    createDrizzleAccountRepository,
    createGoogleIdentityVerifier,
    createJsonWebTokenSessionTokens,
    loadAuthConfig,
} from "../infrastructure/auth";
import { AuthController } from "./auth.controller";
import {
    AUTH_ACCOUNT_REPOSITORY,
    AUTH_CLOCK,
    AUTH_CONFIG,
    DEV_AUTH_CONFIG,
    GOOGLE_IDENTITY_VERIFIER,
    SESSION_TOKENS,
    SIGN_IN_FOR_DEVELOPMENT,
    SIGN_IN_WITH_GOOGLE,
} from "./auth.tokens";

@Module({
    imports: [DatabaseModule],
    controllers: [AuthController],
    providers: [
        {
            provide: AUTH_CONFIG,
            useFactory: loadAuthConfig,
        },
        {
            provide: AUTH_ACCOUNT_REPOSITORY,
            useFactory: (database: Database) =>
                createDrizzleAccountRepository(database),
            inject: [DRIZZLE],
        },
        {
            provide: SESSION_TOKENS,
            useFactory: (config: ReturnType<typeof loadAuthConfig>) =>
                createJsonWebTokenSessionTokens(config.jwtSecret),
            inject: [AUTH_CONFIG],
        },
        {
            provide: GOOGLE_IDENTITY_VERIFIER,
            useFactory: (config: ReturnType<typeof loadAuthConfig>) =>
                createGoogleIdentityVerifier({
                    getClientId: () => config.googleClientId,
                }),
            inject: [AUTH_CONFIG],
        },
        {
            provide: AUTH_CLOCK,
            useFactory: (): Clock => ({ now: () => new Date() }),
        },
        {
            provide: DEV_AUTH_CONFIG,
            useFactory: (
                config: ReturnType<typeof loadAuthConfig>
            ): DevAuthConfig => config.devAuth,
            inject: [AUTH_CONFIG],
        },
        {
            provide: SIGN_IN_WITH_GOOGLE,
            useFactory: (
                googleIdentityVerifier: GoogleIdentityVerifier,
                accounts: AccountRepository,
                sessionTokens: SessionTokens,
                clock: Clock
            ) =>
                new SignInWithGoogle({
                    googleIdentityVerifier,
                    accounts,
                    sessionTokens,
                    clock,
                }),
            inject: [
                GOOGLE_IDENTITY_VERIFIER,
                AUTH_ACCOUNT_REPOSITORY,
                SESSION_TOKENS,
                AUTH_CLOCK,
            ],
        },
        {
            provide: SIGN_IN_FOR_DEVELOPMENT,
            useFactory: (
                accounts: AccountRepository,
                sessionTokens: SessionTokens,
                config: DevAuthConfig
            ) =>
                new SignInForDevelopment({
                    accounts,
                    sessionTokens,
                    config,
                }),
            inject: [AUTH_ACCOUNT_REPOSITORY, SESSION_TOKENS, DEV_AUTH_CONFIG],
        },
    ],
})
export class AuthModule {}
