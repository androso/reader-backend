import { Global, Module } from "@nestjs/common";
import { db } from "../db";

export const DRIZZLE = "DRIZZLE";
export type Database = typeof db;

@Global()
@Module({
    providers: [{ provide: DRIZZLE, useValue: db }],
    exports: [DRIZZLE],
})
export class DatabaseModule {}
