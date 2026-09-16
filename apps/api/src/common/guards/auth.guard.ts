import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from "@nestjs/common";
import type { Request } from "express";
import { verifyToken } from "../../services/AuthService";
import {
    DEV_AUTH_COOKIE,
    parseCookies,
    PROD_AUTH_COOKIE,
} from "../../utils/authCookie";

@Injectable()
export class AuthGuard implements CanActivate {
    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req = context.switchToHttp().getRequest<Request>();
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[PROD_AUTH_COOKIE] ?? cookies[DEV_AUTH_COOKIE];
        if (!token) {
            throw new UnauthorizedException({ message: "No token provided" });
        }
        const user = await verifyToken(token);
        if (!user) {
            throw new UnauthorizedException({ message: "Invalid token" });
        }

        req.user = user;
        return true;
    }
}
