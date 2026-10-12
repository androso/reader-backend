import { OAuth2Client } from "google-auth-library";
import type { GoogleIdentityVerifier } from "@reader/application";

export interface GoogleAuthClient {
    verifyIdToken(input: { idToken: string; audience: string }): Promise<{
        getPayload():
            | {
                  sub?: string;
                  email?: string;
                  name?: string;
                  picture?: string;
              }
            | undefined;
    }>;
}

export interface GoogleIdentityVerifierOptions {
    getClientId?: () => string | undefined;
    createClient?: (clientId: string) => GoogleAuthClient;
    onError?: (error: unknown) => void;
}

export const createGoogleIdentityVerifier = (
    options: GoogleIdentityVerifierOptions = {}
): GoogleIdentityVerifier => {
    const getClientId =
        options.getClientId ?? (() => process.env.GOOGLE_CLIENT_ID);
    const createClient =
        options.createClient ??
        ((clientId) => new OAuth2Client(clientId) as GoogleAuthClient);
    const onError = options.onError ?? console.error;
    let client: GoogleAuthClient | undefined;

    return {
        async verify(token) {
            try {
                const clientId = getClientId();
                if (!token || !clientId) {
                    throw new Error("Google ID token or client ID is missing");
                }

                client ??= createClient(clientId);
                const ticket = await client.verifyIdToken({
                    idToken: token,
                    audience: clientId,
                });
                const data = ticket.getPayload();
                if (!data?.sub || !data.email) {
                    throw new Error("Invalid ID token");
                }

                return {
                    sub: data.sub,
                    email: data.email,
                    name: data.name ?? data.email,
                    picture: data.picture,
                };
            } catch (error) {
                onError(error);
                throw new Error("Failed to verify token");
            }
        },
    };
};
