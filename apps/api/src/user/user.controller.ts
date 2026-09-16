import { Controller, Get, UseGuards } from "@nestjs/common";
import {
    ApiBearerAuth,
    ApiOperation,
    ApiResponse,
    ApiTags,
} from "@nestjs/swagger";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { AuthGuard } from "../common/guards/auth.guard";
import type { User } from "../types";

@ApiTags("User")
@Controller("api/user")
@UseGuards(AuthGuard)
export class UserController {
    @Get()
    @ApiBearerAuth()
    @ApiOperation({
        summary: "Get current user information",
        description: "Retrieves the authenticated user's information",
    })
    @ApiResponse({
        status: 200,
        description: "Successfully retrieved user information",
    })
    @ApiResponse({ status: 401, description: "Unauthorized" })
    getCurrentUser(@CurrentUser() user: User) {
        return { user };
    }
}
