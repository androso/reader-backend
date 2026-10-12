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
import type {
    DevAuthConfig,
    SignInForDevelopment,
    SignInWithGoogle,
} from "@reader/application";
import { AuthRateLimitGuard } from "../common/guards/rate-limit.guard";
import { clearAuthCookies, setAuthCookie } from "../utils/authCookie";
import {
    DEV_AUTH_CONFIG,
    SIGN_IN_FOR_DEVELOPMENT,
    SIGN_IN_WITH_GOOGLE,
} from "./auth.tokens";

@ApiTags("Auth")
@Controller("api/auth")
@UseGuards(AuthRateLimitGuard)
export class AuthController {
    constructor(
        @Inject(SIGN_IN_WITH_GOOGLE)
        private readonly signInWithGoogle: Pick<SignInWithGoogle, "execute">,
        @Inject(SIGN_IN_FOR_DEVELOPMENT)
        private readonly signInForDevelopment: Pick<
            SignInForDevelopment,
            "execute"
        >,
        @Inject(DEV_AUTH_CONFIG)
        private readonly devAuthConfig: DevAuthConfig
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
            const { account, token } = await this.signInWithGoogle.execute(
                idToken as string
            );
            setAuthCookie(res, token);
            return { user: account };
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
        if (!this.devAuthConfig.enabled) {
            throw new NotFoundException({ message: "Not found" });
        }

        try {
            const { account, token } =
                await this.signInForDevelopment.execute();
            setAuthCookie(res, token);
            return { user: account };
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
