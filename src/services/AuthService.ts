import { OAuth2Client } from "google-auth-library";
import jwt, { TokenExpiredError } from "jsonwebtoken";
import { db } from "../db";
import { Users } from "../db/schema";
import { eq } from "drizzle-orm";

if (!process.env.JWT_SECRET) {
    throw new Error("Missing required environment variables for auth");
}

if (!process.env.GOOGLE_CLIENT_ID) {
    throw new Error("Missing client id");
} else if (!process.env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Missing client secret");
}
const client = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
});

export const verifyGoogleToken = async (token: string) => {
    try {
        const response = await fetch(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            {
                headers: { Authorization: `Bearer ${token}` },
            }
        );

        if (!response.ok) {
            throw new Error("Failed to verify token");
        }

        const data = await response.json();

        return {
            sub: data.sub,
            email: data.email,
            name: data.name,
            picture: data.picture,
        };
    } catch (e) {
        console.error(e);
        throw new Error("Failed to verify token");
    }
};

export const generateToken = (user: any) => {
    const tk = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, {
        expiresIn: "7d",
    });
    return tk;
};

export const verifyToken = async (token: any) => {
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
            userId: string;
        };

        const [user] = await db
            .select()
            .from(Users)
            .where(eq(Users.id, decoded.userId));
        return user;
    } catch (e) {
        console.error(e);
        return null;
    }
};
