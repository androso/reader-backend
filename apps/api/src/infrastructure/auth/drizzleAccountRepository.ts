import { eq } from "drizzle-orm";
import type { AccountRepository } from "@reader/application";
import type { Account } from "@reader/domain";
import type { Database } from "../../database/database.module";
import { Users } from "../../db/schema";

type AccountRowMatchesDomain = typeof Users.$inferSelect extends Account
    ? true
    : false;
type DomainAccountMatchesRow = Account extends typeof Users.$inferSelect
    ? true
    : false;
const accountRowTypeChecks: [AccountRowMatchesDomain, DomainAccountMatchesRow] =
    [true, true];
void accountRowTypeChecks;

export const createDrizzleAccountRepository = (
    database: Database
): AccountRepository => ({
    async findByGoogleId(googleId) {
        const [account] = await database
            .select()
            .from(Users)
            .where(eq(Users.googleId, googleId));
        return account ?? null;
    },

    async createFromGoogle(input) {
        const [account] = await database
            .insert(Users)
            .values({
                googleId: input.googleId,
                email: input.email,
                name: input.name,
            })
            .returning();
        return account!;
    },

    async touchByGoogleId(googleId, now) {
        const [account] = await database
            .update(Users)
            .set({ updatedAt: now })
            .where(eq(Users.googleId, googleId))
            .returning();
        return account!;
    },

    async findByEmail(email) {
        const [account] = await database
            .select()
            .from(Users)
            .where(eq(Users.email, email));
        return account ?? null;
    },

    async createDev(input) {
        const [account] = await database
            .insert(Users)
            .values({
                email: input.email,
                name: input.name,
                username: "dev",
            })
            .returning();
        return account!;
    },

    async findById(id) {
        const [account] = await database
            .select()
            .from(Users)
            .where(eq(Users.id, id));
        return account ?? null;
    },
});
