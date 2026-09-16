import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

export const CurrentUser = createParamDecorator(
    (_data, ctx: ExecutionContext) =>
        ctx.switchToHttp().getRequest<Request>().user
);
