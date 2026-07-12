import { Request, Response, NextFunction } from "express";
import { verifyToken } from "../services/AuthService";
import {
    DEV_AUTH_COOKIE,
    parseCookies,
    PROD_AUTH_COOKIE,
} from "../utils/authCookie";

export async function authenticate(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[PROD_AUTH_COOKIE] ?? cookies[DEV_AUTH_COOKIE];
    if (!token) {
        res.status(401).json({ message: "No token provided" });
        return;
    }
    const user = await verifyToken(token);
    if (!user) {
        res.status(401).json({ message: "Invalid token" });
        return;
    }

    req.user = user;
    next();
}
