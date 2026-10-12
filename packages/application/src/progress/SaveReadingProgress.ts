import { BookNotFoundError, validateProgressInput } from "@reader/domain";
import type { SaveReadingProgressInput } from "@reader/domain";
import type { Clock } from "../chat/ports";
import type { ReadingProgressRepository } from "./ports";

export interface SaveReadingProgressDependencies {
    repository: Pick<ReadingProgressRepository, "saveForLiveOwnedBook">;
    clock: Clock;
}

export class SaveReadingProgress {
    constructor(private readonly deps: SaveReadingProgressDependencies) {}

    async execute(
        input: SaveReadingProgressInput & {
            userId: string;
            bookId: string;
        }
    ) {
        const validated = validateProgressInput(input);
        const saved = await this.deps.repository.saveForLiveOwnedBook({
            userId: input.userId,
            bookId: input.bookId,
            position: validated.position,
            chapter: validated.chapter,
            now: this.deps.clock.now(),
        });
        if (!saved) throw new BookNotFoundError(input.bookId);
        return saved;
    }
}
