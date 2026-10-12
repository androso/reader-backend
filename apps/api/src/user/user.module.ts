import { Module } from "@nestjs/common";
import { SessionModule } from "../auth/session.module";
import { UserController } from "./user.controller";

@Module({
    imports: [SessionModule],
    controllers: [UserController],
})
export class UserModule {}
