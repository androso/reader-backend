import type { ChatResourceAccess } from "@reader/application";
import {
    ChatResourceAccessDeniedError,
    ChatResourceNotFoundError,
    ChatValidationError,
} from "@reader/domain";
import {
    authorizeChatResource,
    type ChatResourceAuthorizationRepository,
} from "../../services/ChatResourceAuthorization";
import type { Database } from "../../database/database.module";
import { createDrizzleChatResourceRepository } from "./drizzleChatResourceRepository";

export const createChatResourceAccess = (
    database: Database,
    existingRepository?: ChatResourceAuthorizationRepository
): ChatResourceAccess => {
    const repository: ChatResourceAuthorizationRepository =
        existingRepository ?? createDrizzleChatResourceRepository(database);

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
