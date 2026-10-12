import type { Account } from "@reader/domain";
import type { AuthenticateSessionDependencies } from "./ports";

export class AuthenticateSession {
    constructor(private readonly deps: AuthenticateSessionDependencies) {}

    async execute(token: string): Promise<Account | null> {
        try {
            const accountId = this.deps.sessionTokens.verify(token);
            return await this.deps.accounts.findById(accountId);
        } catch (error) {
            this.deps.onError(error);
            return null;
        }
    }
}
