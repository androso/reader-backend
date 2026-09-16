import { Catch, HttpException } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import type { ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class AllExceptionsFilter extends BaseExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        if (exception instanceof HttpException) {
            return super.catch(exception, host);
        }
        console.error("Unhandled request error", exception);
        const res = host.switchToHttp().getResponse<Response>();
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error" });
        }
    }
}
