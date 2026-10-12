import { and, eq } from "drizzle-orm";
import type { OwnedBookLookup } from "@reader/application";
import type { Database } from "../../database/database.module";
import { db } from "../../db";
import { Books } from "../../db/schema";

export const createOwnedBookLookup = (
    database: Database = db
): OwnedBookLookup => ({
    async findOwned({ userId, bookId }) {
        const [book] = await database
            .select()
            .from(Books)
            .where(and(eq(Books.id, bookId), eq(Books.userId, userId)));
        return book ?? null;
    },
});
