import type { BookProcessingQueue } from "@reader/application";
import type { BookProcessingRequest } from "@reader/domain";
import { enqueueUploadedBookForProcessing } from "../../services/BookProcessingQueue";

export const bullmqBookProcessingQueue: BookProcessingQueue = {
    enqueue: (request: BookProcessingRequest) =>
        enqueueUploadedBookForProcessing(request),
};
