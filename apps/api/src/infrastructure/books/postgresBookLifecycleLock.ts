import type { BookLifecycleLock, Logger } from "@reader/application";
import {
    BookLifecycleLockTimeoutError,
    BookLifecycleLockUnavailableError,
} from "@reader/domain";
import { noopLogger } from "@reader/application";
import type { Pool, PoolClient } from "pg";

export interface PostgresBookLifecycleLockOptions {
    pool: Pick<Pool, "connect">;
    acquireTimeoutMs?: number;
    logger?: Logger;
}

const sqlState = (error: unknown) =>
    error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;

const errorDetail = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const createPostgresBookLifecycleLock = ({
    pool,
    acquireTimeoutMs = 30_000,
    logger = noopLogger,
}: PostgresBookLifecycleLockOptions): BookLifecycleLock => ({
    async withLock<T>(bookId: string, fn: () => Promise<T>): Promise<T> {
        let client: PoolClient;
        try {
            client = await pool.connect();
        } catch (error) {
            logger.error("Unable to acquire book lifecycle connection", {
                bookId,
                error: errorDetail(error),
            });
            throw new BookLifecycleLockUnavailableError(bookId, error);
        }

        let result!: T;
        let operationError: unknown;
        let coordinationError: unknown;
        let timeoutFailure = false;
        let retired = false;
        let timeoutConfigured = false;
        let acquired = false;
        const lockKey = `book-lifecycle:${bookId}`;

        try {
            await client.query("SELECT set_config('lock_timeout', $1, false)", [
                `${acquireTimeoutMs}ms`,
            ]);
            timeoutConfigured = true;
            try {
                await client.query(
                    "SELECT pg_advisory_lock(hashtextextended($1, 0))",
                    [lockKey]
                );
                acquired = true;
            } catch (error) {
                retired = true;
                timeoutFailure = sqlState(error) === "55P03";
                coordinationError = error;
            }

            if (acquired) {
                try {
                    result = await fn();
                } catch (error) {
                    operationError = error;
                }
            } else {
                operationError = timeoutFailure
                    ? new BookLifecycleLockTimeoutError(bookId)
                    : new BookLifecycleLockUnavailableError(
                          bookId,
                          coordinationError
                      );
            }
        } catch (error) {
            retired = true;
            operationError = new BookLifecycleLockUnavailableError(
                bookId,
                error
            );
        }

        let cleanupError: unknown;
        if (acquired) {
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

        if (timeoutConfigured && !retired && !cleanupError) {
            try {
                await client.query("RESET lock_timeout");
            } catch (error) {
                cleanupError = error;
            }
        }

        if (cleanupError) {
            retired = true;
            logger.error("Unable to release book lifecycle lock cleanly", {
                bookId,
                error: errorDetail(cleanupError),
            });
        }
        try {
            client.release(
                retired
                    ? new Error(
                          `Retiring book lifecycle connection for ${bookId}`
                      )
                    : undefined
            );
        } catch (error) {
            cleanupError ??= error;
        }

        if (cleanupError) {
            throw new BookLifecycleLockUnavailableError(bookId, cleanupError);
        }
        if (operationError) throw operationError;
        return result;
    },
});
