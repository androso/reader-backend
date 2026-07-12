import Redis from "ioredis";
import type { NextFunction, Request, Response } from "express";

let redis: Redis | null = null;
const getRedis = () => {
    if (!process.env.REDIS_URL) return null;
    redis ??= new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
    });
    return redis;
};

const fixedWindowScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
return {count, redis.call("TTL", KEYS[1])}
`;

const createRateLimit =
    (
        namespace: string,
        limit: number,
        windowSeconds: number,
        identity: (req: Request) => string
    ) =>
    async (req: Request, res: Response, next: NextFunction) => {
        const client = getRedis();
        if (!client) return next();
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
                res.status(429).json({ error: "Too many requests" });
                return;
            }
        } catch (error) {
            console.error("Rate limiter unavailable", error);
        }
        next();
    };

export const authRateLimit = createRateLimit(
    "auth",
    20,
    15 * 60,
    (req) => req.ip || req.socket.remoteAddress || "unknown"
);
export const uploadRateLimit = createRateLimit(
    "upload",
    10,
    60 * 60,
    (req) => req.user.id
);
export const chatRateLimit = createRateLimit(
    "chat",
    30,
    60,
    (req) => req.user.id
);
