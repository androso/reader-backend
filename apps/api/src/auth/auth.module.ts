import { Module } from "@nestjs/common";
import { DRIZZLE, type Database } from "../database/database.module";
import { AuthController } from "./auth.controller";
import { AUTH_OPERATIONS, createAuthOperations } from "./auth.operations";

@Module({
    controllers: [AuthController],
    providers: [
        {
            provide: AUTH_OPERATIONS,
            useFactory: (db: Database) => createAuthOperations(db),
            inject: [DRIZZLE],
        },
    ],
})
export class AuthModule {}
