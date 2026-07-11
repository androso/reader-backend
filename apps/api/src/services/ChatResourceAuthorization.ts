export type SupportedChatResourceType = "book";

export type ChatResourceAuthorizationRepository = {
    findBookById: (
        resourceId: string
    ) => Promise<{ id: string; userId: string } | null>;
};

export type CreateChatConversationRepository =
    ChatResourceAuthorizationRepository & {
        createConversation: (input: {
            userId: string;
            title: string;
            resourceType: SupportedChatResourceType;
            resourceId: string;
        }) => Promise<{ id: string }>;
    };

export type ChatResourceAuthorizationFailure = {
    ok: false;
    status: 400 | 403 | 404;
    error: string;
};

export type ChatResourceAuthorizationResult =
    | { ok: true; resourceType: SupportedChatResourceType }
    | ChatResourceAuthorizationFailure;

export type CreateAuthorizedChatConversationResult =
    | {
          ok: true;
          resourceType: SupportedChatResourceType;
          conversation: { id: string };
      }
    | ChatResourceAuthorizationFailure;

export const isSupportedChatResourceType = (
    resourceType: string
): resourceType is SupportedChatResourceType => resourceType === "book";

export const authorizeChatResource = async ({
    resourceType,
    resourceId,
    userId,
    repository,
}: {
    resourceType: string;
    resourceId: string;
    userId: string;
    repository: ChatResourceAuthorizationRepository;
}): Promise<ChatResourceAuthorizationResult> => {
    if (!isSupportedChatResourceType(resourceType)) {
        return {
            ok: false,
            status: 400,
            error: "Unsupported resource type",
        };
    }

    const book = await repository.findBookById(resourceId);
    if (!book) {
        return {
            ok: false,
            status: 404,
            error: "Book not found",
        };
    }

    if (book.userId !== userId) {
        return {
            ok: false,
            status: 403,
            error: "Book access denied",
        };
    }

    return { ok: true, resourceType };
};

export const createAuthorizedChatConversation = async ({
    resourceType,
    resourceId,
    userId,
    title,
    repository,
}: {
    resourceType: string;
    resourceId: string;
    userId: string;
    title: string;
    repository: CreateChatConversationRepository;
}): Promise<CreateAuthorizedChatConversationResult> => {
    const authorization = await authorizeChatResource({
        resourceType,
        resourceId,
        userId,
        repository,
    });
    if (!authorization.ok) return authorization;

    const conversation = await repository.createConversation({
        userId,
        title,
        resourceType: authorization.resourceType,
        resourceId,
    });

    return {
        ok: true,
        resourceType: authorization.resourceType,
        conversation,
    };
};
