import { Global, Module } from "@nestjs/common";
import Redis from "ioredis";

export const RATE_LIMIT_CLIENT = "RATE_LIMIT_CLIENT";

export type RateLimitClient = Pick<Redis, "status" | "connect" | "eval">;

export type RateLimitClientOwner = {
    get(): RateLimitClient | null;
    close(): Promise<void>;
};

type ManagedRateLimitClient = RateLimitClient & {
    quit(): Promise<unknown>;
    disconnect(): void;
};

export type RateLimitClientFactory = (
    url: string,
    options: {
        lazyConnect: boolean;
        maxRetriesPerRequest: number;
        enableOfflineQueue: boolean;
    }
) => ManagedRateLimitClient;

export const createRateLimitClientOwner = (
    createClient: RateLimitClientFactory = (url, options) =>
        new Redis(url, options)
): RateLimitClientOwner => {
    let client: ManagedRateLimitClient | null = null;
    let closing: Promise<void> | undefined;
    return {
        get() {
            if (closing || !process.env.REDIS_URL) return null;
            client ??= createClient(process.env.REDIS_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
                enableOfflineQueue: false,
            });
            return client;
        },
        close() {
            return (closing ??= (async () => {
                const current = client;
                client = null;
                if (!current) return;
                if (current.status === "wait" || current.status === "end") {
                    current.disconnect();
                    return;
                }
                try {
                    await current.quit();
                } finally {
                    current.disconnect();
                }
            })());
        },
    };
};

export const defaultRateLimitClientOwner = createRateLimitClientOwner();

@Global()
@Module({
    providers: [
        {
            provide: RATE_LIMIT_CLIENT,
            useValue: defaultRateLimitClientOwner,
        },
    ],
    exports: [RATE_LIMIT_CLIENT],
})
export class RateLimitModule {}
