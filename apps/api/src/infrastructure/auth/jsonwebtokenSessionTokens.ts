import jwt from "jsonwebtoken";
import type { SessionTokens } from "@reader/application";

export const createJsonWebTokenSessionTokens = (
    secret: string
): SessionTokens => ({
    issue(accountId) {
        return jwt.sign({ userId: accountId }, secret, { expiresIn: "7d" });
    },
    verify(token) {
        const decoded = jwt.verify(token, secret) as { userId: string };
        return decoded.userId;
    },
});
