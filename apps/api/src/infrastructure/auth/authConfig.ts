import type { DevAuthConfig } from "@reader/application";

export interface AuthConfig {
    jwtSecret: string;
    googleClientId: string | undefined;
    googleClientSecret: string | undefined;
    devAuth: DevAuthConfig;
}

export const loadAuthConfig = (): AuthConfig => {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
        throw new Error("Missing required JWT_SECRET environment variable");
    }

    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (
        process.env.NODE_ENV === "production" &&
        (!googleClientId || !googleClientSecret)
    ) {
        throw new Error("Missing required Google auth environment variables");
    }

    return {
        jwtSecret,
        googleClientId,
        googleClientSecret,
        devAuth: {
            enabled: process.env.NODE_ENV !== "production",
            email: process.env.DEV_USER_EMAIL || "dev@example.com",
            name: process.env.DEV_USER_NAME || "Dev User",
        },
    };
};
