import {
    CanActivate,
    ExecutionContext,
    HttpException,
    Inject,
    Injectable,
    Type,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
    RATE_LIMIT_CLIENT,
    type RateLimitClientOwner,
} from "../rate-limit.module";

export const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return {count, redis.call("TTL", KEYS[1])}
`;

export const createRateLimitGuard = (
    namespace: string,
    limit: number,
    windowSeconds: number,
    identity: (req: Request) => string
): Type<CanActivate> => {
    @Injectable()
    class RateLimitGuard implements CanActivate {
        constructor(
            @Inject(RATE_LIMIT_CLIENT)
            private readonly rateLimitClient: RateLimitClientOwner
        ) {}

        async canActivate(context: ExecutionContext): Promise<boolean> {
            const req = context.switchToHttp().getRequest<Request>();
            const res = context.switchToHttp().getResponse<Response>();
            const client = this.rateLimitClient.get();
            if (!client) return true;
            try {
                if (client.status === "wait") await client.connect();
                const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
                const key = `reader:rate:${namespace}:${identity(req)}:${bucket}`;
                const [count, ttl] = (await client.eval(
                    fixedWindowScript,
                    1,
                    key,
                    windowSeconds
                )) as [number, number];
                if (count > limit) {
                    res.setHeader("Retry-After", String(Math.max(ttl, 1)));
                    throw new HttpException(
                        { error: "Too many requests" },
                        429
                    );
                }
            } catch (error) {
                if (error instanceof HttpException) throw error;
                console.error("Rate limiter unavailable", error);
            }
            return true;
        }
    }
    return RateLimitGuard;
};

export const AuthRateLimitGuard = createRateLimitGuard(
    "auth",
    20,
    15 * 60,
    (req) => req.ip || req.socket.remoteAddress || "unknown"
);
export const UploadRateLimitGuard = createRateLimitGuard(
    "upload",
    10,
    60 * 60,
    (req) => req.user.id
);
export const ChatRateLimitGuard = createRateLimitGuard(
    "chat",
    30,
    60,
    (req) => req.user.id
);
