import type { Account } from "@reader/domain";
import type { SignInForDevelopmentDependencies } from "./ports";

export class SignInForDevelopment {
    constructor(private readonly deps: SignInForDevelopmentDependencies) {}

    async execute(): Promise<{ account: Account; token: string }> {
        if (!this.deps.config.enabled) {
            throw new Error("Dev auth is not available in production");
        }

        const existing = await this.deps.accounts.findByEmail(
            this.deps.config.email
        );
        const account =
            existing ??
            (await this.deps.accounts.createDev({
                email: this.deps.config.email,
                name: this.deps.config.name,
            }));

        return {
            account,
            token: this.deps.sessionTokens.issue(account.id),
        };
    }
}
