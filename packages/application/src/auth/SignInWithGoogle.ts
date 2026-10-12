import type { Account } from "@reader/domain";
import type { SignInWithGoogleDependencies } from "./ports";

export class SignInWithGoogle {
    constructor(private readonly deps: SignInWithGoogleDependencies) {}

    async execute(token: string): Promise<{ account: Account; token: string }> {
        const identity = await this.deps.googleIdentityVerifier.verify(token);
        const existing = await this.deps.accounts.findByGoogleId(identity.sub);
        const account = existing
            ? await this.deps.accounts.touchByGoogleId(
                  identity.sub,
                  this.deps.clock.now()
              )
            : await this.deps.accounts.createFromGoogle({
                  googleId: identity.sub,
                  email: identity.email,
                  name: identity.name,
              });

        return {
            account,
            token: this.deps.sessionTokens.issue(account.id),
        };
    }
}
