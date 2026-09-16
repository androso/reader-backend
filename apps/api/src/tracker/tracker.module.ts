import { Module } from "@nestjs/common";
import { TrackerController } from "./tracker.controller";

@Module({
    controllers: [TrackerController],
})
export class TrackerModule {}
