import type { ChatResourceAccess } from "@reader/application";
import {
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} from "@reader/domain";
import { eq } from "drizzle-orm";
import {
    authorizeChatResource,
    type ChatResourceAuthorizationRepository,
} from "../../services/ChatResourceAuthorization";
import type { Database } from "../../database/database.module";
import { Books } from "../../db/schema";

export const createChatResourceAccess = (
    database: Database
): ChatResourceAccess => {
    const repository: ChatResourceAuthorizationRepository = {
        findBookById: async (resourceId) => {
            const [book] = await database
                .select({
                    id: Books.id,
                    userId: Books.userId,
                })
                .from(Books)
                .where(eq(Books.id, resourceId));
            return book ?? null;
        },
    };

    return {
        async authorize({ userId, resourceType, resourceId }) {
            const authorization = await authorizeChatResource({
                userId,
                resourceType,
                resourceId,
                repository,
            });
            if (authorization.ok) {
                return { resourceType: authorization.resourceType };
            }

            if (authorization.status === 400) {
                throw new ChatValidationError(
                    "unsupported_resource_type",
                    authorization.error
                );
            }
            if (authorization.status === 404) {
                throw new ChatResourceNotFoundError(authorization.error);
            }
            throw new ChatResourceAccessDeniedError(authorization.error);
        },
    };
};
