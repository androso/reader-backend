import type { BookLifecycleLock, Logger } from "@reader/application";
import {
    BookLifecycleLockLostError,
    BookLifecycleLockTimeoutError,
    BookLifecycleLockUnavailableError,
} from "@reader/domain";
import { noopLogger } from "@reader/application";
import type { Pool, PoolClient } from "pg";

export interface PostgresBookLifecycleLockOptions {
    pool: Pick<Pool, "connect"> & { options?: { max?: number } };
    acquireTimeoutMs?: number;
    maxConcurrentLocks?: number;
    logger?: Logger;
}

type ReleaseSlot = () => void;

interface SemaphoreWaiter {
    bookId: string;
    resolve: (release: ReleaseSlot) => void;
    reject: (error: unknown) => void;
    timer?: ReturnType<typeof setTimeout>;
}

const createFifoSemaphore = (capacity: number) => {
    let active = 0;
    const waiters: SemaphoreWaiter[] = [];

    const createRelease = (): ReleaseSlot => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const waiter = waiters.shift();
            if (waiter) {
                if (waiter.timer) clearTimeout(waiter.timer);
                waiter.resolve(createRelease());
            } else {
                active -= 1;
            }
        };
    };

    return {
        acquire(bookId: string, deadline: number): Promise<ReleaseSlot> {
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                return Promise.reject(
                    new BookLifecycleLockTimeoutError(bookId)
                );
            }
            if (active < capacity && waiters.length === 0) {
                active += 1;
                return Promise.resolve(createRelease());
            }

            return new Promise<ReleaseSlot>((resolve, reject) => {
                const waiter: SemaphoreWaiter = {
                    bookId,
                    resolve,
                    reject,
                };
                waiter.timer = setTimeout(() => {
                    const index = waiters.indexOf(waiter);
                    if (index === -1) return;
                    waiters.splice(index, 1);
                    reject(new BookLifecycleLockTimeoutError(bookId));
                }, remainingMs);
                waiters.push(waiter);
            });
        },
    };
};

const sqlState = (error: unknown) =>
    error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

const errorDetail = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const createPostgresBookLifecycleLock = ({
    pool,
    acquireTimeoutMs = 30_000,
    maxConcurrentLocks = Math.max(1, Math.floor((pool.options?.max ?? 10) / 2)),
    logger = noopLogger,
}: PostgresBookLifecycleLockOptions): BookLifecycleLock => {
    const semaphore = createFifoSemaphore(
        Math.max(1, Math.floor(maxConcurrentLocks))
    );

    return {
        async withLock<T>(
            bookId: string,
            fn: (signal: AbortSignal) => Promise<T>
        ): Promise<T> {
            const deadline = Date.now() + acquireTimeoutMs;
            const releaseSlot = await semaphore.acquire(bookId, deadline);
            let client: PoolClient | undefined;
            let onError: ((error: Error) => void) | undefined;
            let lockLostError: BookLifecycleLockLostError | undefined;
            let result!: T;
            let operationError: unknown;
            let cleanupError: unknown;
            let timeoutFailure = false;
            let retired = false;
            let timeoutConfigured = false;
            let acquired = false;
            let rejectLockLost!: (error: BookLifecycleLockLostError) => void;
            const lockLost = new Promise<never>((_, reject) => {
                rejectLockLost = reject;
            });
            void lockLost.catch(() => {});
            const lockKey = `book-lifecycle:${bookId}`;

            try {
                try {
                    client = await pool.connect();
                } catch (error) {
                    logger.error(
                        "Unable to acquire book lifecycle connection",
                        {
                            bookId,
                            error: errorDetail(error),
                        }
                    );
                    operationError = new BookLifecycleLockUnavailableError(
                        bookId,
                        error
                    );
                }

                if (client) {
                    const abortController = new AbortController();
                    onError = (error) => {
                        if (lockLostError) return;
                        lockLostError = new BookLifecycleLockLostError(
                            bookId,
                            error
                        );
                        logger.error("Book lifecycle lock connection lost", {
                            bookId,
                            error: errorDetail(error),
                        });
                        abortController.abort(lockLostError);
                        rejectLockLost(lockLostError);
                    };
                    client.on("error", onError);

                    const remainingMs = deadline - Date.now();
                    if (remainingMs <= 0) {
                        operationError = new BookLifecycleLockTimeoutError(
                            bookId
                        );
                    } else {
                        try {
                            await client.query(
                                "SELECT set_config('lock_timeout', $1, false)",
                                [`${remainingMs}ms`]
                            );
                            timeoutConfigured = true;
                            await client.query(
                                "SELECT pg_advisory_lock(hashtextextended($1, 0))",
                                [lockKey]
                            );
                            acquired = true;
                        } catch (error) {
                            retired = true;
                            timeoutFailure = sqlState(error) === "55P03";
                            operationError = timeoutFailure
                                ? new BookLifecycleLockTimeoutError(bookId)
                                : new BookLifecycleLockUnavailableError(
                                      bookId,
                                      error
                                  );
                        }
                    }

                    if (acquired && !lockLostError) {
                        try {
                            result = await Promise.race([
                                fn(abortController.signal),
                                lockLost,
                            ]);
                        } catch (error) {
                            operationError = error;
                        }
                    }

                    if (lockLostError) operationError = lockLostError;

                    if (acquired && !lockLostError) {
                        try {
                            const unlocked = await client.query(
                                "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked",
                                [lockKey]
                            );
                            if (unlocked.rows[0]?.unlocked !== true) {
                                cleanupError = new Error(
                                    "PostgreSQL advisory lock was not held during unlock"
                                );
                            }
                        } catch (error) {
                            cleanupError = error;
                        }
                    }

                    if (
                        timeoutConfigured &&
                        !retired &&
                        !cleanupError &&
                        !lockLostError
                    ) {
                        try {
                            await client.query("RESET lock_timeout");
                        } catch (error) {
                            cleanupError = error;
                        }
                    }

                    if (cleanupError) {
                        retired = true;
                        logger.error(
                            "Unable to release book lifecycle lock cleanly",
                            {
                                bookId,
                                error: errorDetail(cleanupError),
                            }
                        );
                    }

                    if (onError) client.removeListener("error", onError);
                    try {
                        client.release(
                            lockLostError ??
                                (retired
                                    ? new Error(
                                          `Retiring book lifecycle connection for ${bookId}`
                                      )
                                    : undefined)
                        );
                    } catch (error) {
                        cleanupError ??= error;
                    }
                }
            } finally {
                releaseSlot();
            }

            if (lockLostError) throw lockLostError;
            if (cleanupError) {
                throw new BookLifecycleLockUnavailableError(
                    bookId,
                    cleanupError
                );
            }
            if (operationError) throw operationError;
            return result;
        },
    };
};
