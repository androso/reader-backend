import type { Account } from "@reader/domain";
import type { Clock } from "../chat/ports";

export interface GoogleIdentity {
    sub: string;
    email: string;
    name: string;
    picture?: string;
}

export interface GoogleIdentityVerifier {
    verify(token: string): Promise<GoogleIdentity>;
}

export interface AccountRepository {
    findByGoogleId(googleId: string): Promise<Account | null>;
    createFromGoogle(input: {
        googleId: string;
        email: string;
        name: string;
    }): Promise<Account>;
    touchByGoogleId(googleId: string, now: Date): Promise<Account>;
    findByEmail(email: string): Promise<Account | null>;
    createDev(input: { email: string; name: string }): Promise<Account>;
    findById(id: string): Promise<Account | null>;
}

export interface SessionTokens {
    issue(accountId: string): string;
    verify(token: string): string;
}

export interface DevAuthConfig {
    enabled: boolean;
    email: string;
    name: string;
}

export interface SignInWithGoogleDependencies {
    googleIdentityVerifier: GoogleIdentityVerifier;
    accounts: Pick<
        AccountRepository,
        "findByGoogleId" | "createFromGoogle" | "touchByGoogleId"
    >;
    sessionTokens: SessionTokens;
    clock: Clock;
}

export interface SignInForDevelopmentDependencies {
    accounts: Pick<AccountRepository, "findByEmail" | "createDev">;
    sessionTokens: SessionTokens;
    config: DevAuthConfig;
}

export interface AuthenticateSessionDependencies {
    accounts: Pick<AccountRepository, "findById">;
    sessionTokens: SessionTokens;
    onError(error: unknown): void;
}
