import { Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { ArgumentsHost } from "@nestjs/common";
import type { Request, Response } from "express";

const isFrameworkErrorBody = (
    body: unknown
): body is { statusCode: unknown; error: unknown; message: unknown } =>
    Boolean(
        body &&
            typeof body === "object" &&
            "statusCode" in body &&
            "error" in body &&
            "message" in body
    );

const isMultipartRequest = (req: Request) =>
    /^multipart\/form-data\b/i.test(req.headers["content-type"] ?? "");

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        if (exception instanceof HttpException) {
            const status = exception.getStatus();
            const body = exception.getResponse();
            const req = host.switchToHttp().getRequest<Request>();
            if (
                (status === 400 || status === 413) &&
                isFrameworkErrorBody(body) &&
                isMultipartRequest(req)
            ) {
                const res = host.switchToHttp().getResponse<Response>();
                if (!res.headersSent) {
                    if (
                        body.message === "Field value too long" ||
                        status === 413
                    ) {
                        res.status(413).json({ error: "Payload too large" });
                    } else {
                        res.status(400).json({ error: "Malformed upload" });
                    }
                }
                return;
            }
            return super.catch(exception, host);
        }
        console.error("Unhandled request error", exception);
        const res = host.switchToHttp().getResponse<Response>();
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
        }
    }
}
