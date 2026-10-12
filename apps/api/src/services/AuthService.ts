import type { AccountRepository, DevAuthConfig } from "@reader/application";
import { AuthenticateSession, SignInForDevelopment } from "@reader/application";
import { db } from "../db";
import type { Database } from "../database/database.module";
import {
    createDrizzleAccountRepository,
    createGoogleIdentityVerifier,
    createJsonWebTokenSessionTokens,
    loadAuthConfig,
} from "../infrastructure/auth";

const importTimeAuthConfig = loadAuthConfig();
const googleIdentityVerifier = createGoogleIdentityVerifier({
    getClientId: () => process.env.GOOGLE_CLIENT_ID,
});

export const verifyGoogleToken = async (token: string) =>
    googleIdentityVerifier.verify(token);

export const generateToken = (user: { id: string } | any) =>
    createJsonWebTokenSessionTokens(
        process.env.JWT_SECRET ?? importTimeAuthConfig.jwtSecret
    ).issue(user.id);

const currentDevAuthConfig = (): DevAuthConfig => ({
    enabled: process.env.NODE_ENV !== "production",
    email: process.env.DEV_USER_EMAIL || "dev@example.com",
    name: process.env.DEV_USER_NAME || "Dev User",
});

export const getOrCreateDevUser = async (database: Database = db) => {
    const accounts: AccountRepository =
        createDrizzleAccountRepository(database);
    const { account } = await new SignInForDevelopment({
        accounts,
        sessionTokens: createJsonWebTokenSessionTokens(
            process.env.JWT_SECRET ?? importTimeAuthConfig.jwtSecret
        ),
        config: currentDevAuthConfig(),
    }).execute();
    return account;
};

export const verifyToken = async (token: any, database: Database = db) =>
    new AuthenticateSession({
        accounts: createDrizzleAccountRepository(database),
        sessionTokens: createJsonWebTokenSessionTokens(process.env.JWT_SECRET!),
        onError: console.error,
    }).execute(token);
