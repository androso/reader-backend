import {
    AuthenticateSession,
    SignInForDevelopment,
    SignInWithGoogle,
} from "@reader/application";
import type { Clock } from "@reader/application";
import type { Database } from "../../database/database.module";
import { db } from "../../db";
import type { AuthConfig } from "./authConfig";
import { loadAuthConfig } from "./authConfig";
import { createDrizzleAccountRepository } from "./drizzleAccountRepository";
import { createGoogleIdentityVerifier } from "./googleIdentityVerifier";
import { createJsonWebTokenSessionTokens } from "./jsonwebtokenSessionTokens";

export const createAuthUseCases = (
    database: Database = db,
    config: AuthConfig = loadAuthConfig(),
    onError: (error: unknown) => void = console.error
) => {
    const accounts = createDrizzleAccountRepository(database);
    const sessionTokens = createJsonWebTokenSessionTokens(config.jwtSecret);
    const googleIdentityVerifier = createGoogleIdentityVerifier({
        getClientId: () => config.googleClientId,
    });
    const clock: Clock = { now: () => new Date() };

    return {
        accounts,
        sessionTokens,
        googleIdentityVerifier,
        signInWithGoogle: new SignInWithGoogle({
            accounts,
            googleIdentityVerifier,
            sessionTokens,
            clock,
        }),
        signInForDevelopment: new SignInForDevelopment({
            accounts,
            sessionTokens,
            config: config.devAuth,
        }),
        authenticateSession: new AuthenticateSession({
            accounts,
            sessionTokens,
            onError,
        }),
    };
};

export const createAuthenticateSession = (
    database: Database = db,
    config: AuthConfig = loadAuthConfig(),
    onError: (error: unknown) => void = console.error
) => createAuthUseCases(database, config, onError).authenticateSession;
