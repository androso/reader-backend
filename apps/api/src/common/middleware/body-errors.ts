import type { ErrorRequestHandler } from "express";

export const handleBodyParserError: ErrorRequestHandler = (
    error,
    _req,
    res,
    next
) => {
    if (
        error?.type === "entity.too.large" ||
        error?.type === "parameters.too.many"
    ) {
        res.status(413).json({ error: "Payload too large" });
        return;
    }

    if (
        error?.type === "entity.parse.failed" ||
        error?.type === "request.size.invalid" ||
        error?.type === "request.aborted"
    ) {
        res.status(400).json({ error: "Malformed request body" });
        return;
    }

    next(error);
};
