import type { NextFunction, Request, Response } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const enforceTrustedOrigin = (
    req: Request,
    res: Response,
    next: NextFunction
) => {
    if (SAFE_METHODS.has(req.method)) return next();

    const expectedOrigin = process.env.FRONTEND_URL;
    const origin = req.get("origin");
    if (!expectedOrigin || origin !== expectedOrigin) {
        res.status(403).json({ message: "Untrusted request origin" });
        return;
    }
    next();
};
