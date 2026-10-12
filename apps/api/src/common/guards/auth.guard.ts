import {
    CanActivate,
    ExecutionContext,
    Inject,
    Injectable,
    UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticateSession } from "@reader/application";
import { AUTHENTICATE_SESSION } from "../../auth/auth.tokens";
import {
    DEV_AUTH_COOKIE,
    parseCookies,
    PROD_AUTH_COOKIE,
} from "../../utils/authCookie";

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        @Inject(AUTHENTICATE_SESSION)
        private readonly authenticateSession: Pick<
            AuthenticateSession,
            "execute"
        >
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>();
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[PROD_AUTH_COOKIE] ?? cookies[DEV_AUTH_COOKIE];
        if (!token) {
            throw new UnauthorizedException({ message: "No token provided" });
        }
        const user = await this.authenticateSession.execute(token);
        if (!user) {
            throw new UnauthorizedException({ message: "Invalid token" });
        }

        req.user = user;
        return true;
    }
}
