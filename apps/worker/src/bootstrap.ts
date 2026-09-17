import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { defaultWorkerResources, WorkerModule } from "./worker.module";

export const createWorkerApp = async (): Promise<INestApplicationContext> => {
    try {
        defaultWorkerResources.startTracing("reader-worker");
        return await NestFactory.createApplicationContext(WorkerModule, {
            abortOnError: false,
        });
    } catch (error) {
        try {
            await defaultWorkerResources.close();
        } catch (closeError) {
            throw new AggregateError(
                [error, closeError],
                "Worker startup and shutdown failed"
            );
        }
        throw error;
    }
};
