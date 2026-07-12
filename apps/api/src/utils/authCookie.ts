import type { Response } from "express";

export const AUTH_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
export const PROD_AUTH_COOKIE = "__Host-reader_session";
export const DEV_AUTH_COOKIE = "reader_session";

export const getAuthCookieName = () =>
    process.env.NODE_ENV === "production" ? PROD_AUTH_COOKIE : DEV_AUTH_COOKIE;

export const parseCookies = (header?: string): Record<string, string> =>
    Object.fromEntries(
        (header ?? "")
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const separator = part.indexOf("=");
                if (separator < 0) return [part, ""];
                return [
                    part.slice(0, separator),
                    decodeURIComponent(part.slice(separator + 1)),
                ];
            })
    );

const cookieOptions = () =>
    ({
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        path: "/",
    }) as const;

export const setAuthCookie = (res: Response, token: string) => {
    res.cookie(getAuthCookieName(), token, {
        ...cookieOptions(),
        maxAge: AUTH_COOKIE_MAX_AGE_SECONDS * 1000,
    });
};

export const clearAuthCookies = (res: Response) => {
    res.clearCookie(PROD_AUTH_COOKIE, {
        httpOnly: true,
        secure: true,
        sameSite: "none",
        path: "/",
    });
    res.clearCookie(DEV_AUTH_COOKIE, {
        httpOnly: true,
        secure: false,
        sameSite: "lax",
        path: "/",
    });
};
