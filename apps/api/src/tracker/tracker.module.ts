import { Module } from "@nestjs/common";
import { SessionModule } from "../auth/session.module";
import { GetReadingProgress, SaveReadingProgress } from "@reader/application";
import { DRIZZLE, type Database } from "../database/database.module";
import { createOwnedBookLookup } from "../infrastructure/rag/ownedBookLookup";
import { createDrizzleReadingProgressRepository } from "../infrastructure/progress";
import { TrackerController } from "./tracker.controller";
import {
    GET_READING_PROGRESS,
    READING_PROGRESS_REPOSITORY,
    SAVE_READING_PROGRESS,
} from "./progress.tokens";

export const TRACKER_USE_CASE_PROVIDERS = [
    {
        provide: READING_PROGRESS_REPOSITORY,
        useFactory: (database: Database) =>
            createDrizzleReadingProgressRepository(database),
        inject: [DRIZZLE],
    },
    {
        provide: GET_READING_PROGRESS,
        useFactory: (
            database: Database,
            repository: ReturnType<
                typeof createDrizzleReadingProgressRepository
            >
        ) =>
            new GetReadingProgress({
                books: createOwnedBookLookup(database),
                progress: repository,
            }),
        inject: [DRIZZLE, READING_PROGRESS_REPOSITORY],
    },
    {
        provide: SAVE_READING_PROGRESS,
        useFactory: (
            repository: ReturnType<
                typeof createDrizzleReadingProgressRepository
            >
        ) =>
            new SaveReadingProgress({
                repository,
                clock: { now: () => new Date() },
            }),
        inject: [READING_PROGRESS_REPOSITORY],
    },
];

@Module({
    imports: [SessionModule],
    controllers: [TrackerController],
    providers: [...TRACKER_USE_CASE_PROVIDERS],
})
export class TrackerModule {}
