import {
    Body,
    Controller,
    HttpCode,
    HttpException,
    Inject,
    NotFoundException,
    Post,
    Res,
    UnauthorizedException,
    UseGuards,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { eq } from "drizzle-orm";
import { AuthRateLimitGuard } from "../common/guards/rate-limit.guard";
import { DRIZZLE, type Database } from "../database/database.module";
import { Users } from "../db/schema";
import { clearAuthCookies, setAuthCookie } from "../utils/authCookie";
import { AUTH_OPERATIONS, type AuthOperations } from "./auth.operations";

@ApiTags("Auth")
@Controller("api/auth")
@UseGuards(AuthRateLimitGuard)
export class AuthController {
    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Inject(AUTH_OPERATIONS)
        private readonly operations: AuthOperations
    ) {}

    @Post("google")
    @HttpCode(200)
    @ApiOperation({
        summary: "Authenticate user with Google OAuth token",
        description:
            "Validates Google OAuth token and creates/updates user in database",
    })
    @ApiBody({
        schema: {
            type: "object",
            properties: {
                idToken: {
                    type: "string",
                    description: "Google OAuth ID token",
                    example: "eyJhbGciOiJSUzI1NiIsImtpZCI6IjFiZDY3...",
                },
            },
            required: ["idToken"],
        },
    })
    @ApiResponse({ status: 200, description: "Authentication successful" })
    @ApiResponse({ status: 401, description: "Authentication failed" })
    async google(
        @Body() body: { idToken?: string },
        @Res({ passthrough: true }) res: Response
    ) {
        try {
            const { idToken } = body;
            const payload = await this.operations.verifyGoogleToken(
                idToken as string
            );
            const [existingUser] = await this.db
                .select()
                .from(Users)
                .where(eq(Users.googleId, payload.sub));

            let user = existingUser;
            if (!user) {
                [user] = await this.db
                    .insert(Users)
                    .values({
                        googleId: payload.sub,
                        email: payload.email,
                        name: payload.name,
                    })
                    .returning();
            } else {
                [user] = await this.db
                    .update(Users)
                    .set({ updatedAt: new Date() })
                    .where(eq(Users.googleId, payload.sub))
                    .returning();
            }

            const jwtToken = this.operations.generateToken(user);
            setAuthCookie(res, jwtToken);
            return { user };
        } catch (e) {
            console.error(e);
            throw new UnauthorizedException({
                message: "Authentication failed",
            });
        }
    }

    @Post("dev")
    @HttpCode(200)
    async dev(@Res({ passthrough: true }) res: Response) {
        if (process.env.NODE_ENV === "production") {
            throw new NotFoundException({ message: "Not found" });
        }

        try {
            const user = await this.operations.getOrCreateDevUser();
            const token = this.operations.generateToken(user);
            setAuthCookie(res, token);
            return { user };
        } catch (error) {
            console.error("Dev auth failed", error);
            throw new HttpException({ message: "Dev auth failed" }, 500);
        }
    }

    @Post("logout")
    @HttpCode(204)
    logout(@Res({ passthrough: true }) res: Response) {
        clearAuthCookies(res);
    }
}
