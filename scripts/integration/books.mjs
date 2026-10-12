import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    copyFileSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { delimiter, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const suite = process.argv[2] ?? "books";
const integrationTest =
    suite === "auth"
        ? ".tmp/apps-api-integration/test-integration/auth.test.js"
        : suite === "chat"
          ? ".tmp/apps-api-integration/test-integration/chat.test.js"
          : suite === "rag"
            ? ".tmp/apps-api-integration/test-integration/rag.test.js"
            : suite === "progress"
              ? ".tmp/apps-api-integration/test-integration/progress.test.js"
              : suite === "journeys"
                ? ".tmp/apps-api-integration/test-integration/journeys.test.js"
                : ".tmp/apps-api-integration/test-integration/booksLifecycle.test.js";
const expectedPasses =
    suite === "auth"
        ? 3
        : suite === "chat"
          ? 3
          : suite === "rag"
            ? 3
            : suite === "progress"
              ? 6
              : suite === "journeys"
                ? 9
                : 10;
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const postgresName = `reader-it-postgres-${suffix}`;
const redisName = `reader-it-redis-${suffix}`;
const upgradeDatabaseName = `reader_it_progress_upgrade_${suffix.replaceAll("-", "_")}`;
const upgradeMigrationDir = resolve(root, ".tmp/progress-previous-migrations");
const upgradeConfigPath = resolve(
    root,
    ".tmp/progress-previous.drizzle.config.ts"
);
const usesRedis = suite !== "progress" && suite !== "auth";
const activeChildren = new Set();
let receivedSignal;
let resolveSignalProbe;
let signalProbeKeepAlive;

const terminate = (child, signal = "SIGTERM") => {
    if (!child.pid) return;
    try {
        if (process.platform !== "win32") process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch {}
};

const onSignal = (signal) => {
    if (receivedSignal) return;
    receivedSignal = signal;
    for (const child of activeChildren) terminate(child);
    resolveSignalProbe?.();
};
const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);

const run = (command, args, options = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
        const {
            timeoutMs = 10 * 60 * 1000,
            allowAfterSignal = false,
            ...spawnOptions
        } = options;
        if (receivedSignal && !allowAfterSignal) {
            rejectPromise(
                new Error(`Integration harness received ${receivedSignal}`)
            );
            return;
        }
        const child = spawn(command, args, {
            cwd: root,
            env: process.env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            ...spawnOptions,
        });
        activeChildren.add(child);
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            terminate(child);
        }, timeoutMs);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            process.stdout.write(chunk);
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            process.stderr.write(chunk);
        });
        child.once("error", (error) => {
            clearTimeout(timer);
            activeChildren.delete(child);
            rejectPromise(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            activeChildren.delete(child);
            if (timedOut) {
                rejectPromise(
                    new Error(
                        `${command} ${args.join(" ")} timed out after ${timeoutMs}ms`
                    )
                );
            } else if (code !== 0) {
                rejectPromise(
                    new Error(
                        `${command} ${args.join(" ")} exited with ${code ?? signal ?? "unknown"}`
                    )
                );
            } else {
                resolvePromise(stdout.trim());
            }
        });
    });

const waitFor = async (description, check) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
        if (receivedSignal)
            throw new Error(`Interrupted while waiting for ${description}`);
        try {
            if (check()) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${description}`);
};

const cleanup = async (name) => {
    try {
        await run("docker", ["rm", "--force", name], {
            timeoutMs: 30_000,
            allowAfterSignal: true,
        });
    } catch {}
};

let blockedReason;
let upgradeDatabaseUrl;
let localStoragePath;
try {
    try {
        await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
        await run("docker", [
            "run",
            "--rm",
            "--detach",
            "--name",
            postgresName,
            "--publish",
            "127.0.0.1::5432",
            "--env",
            "POSTGRES_USER=reader_it",
            "--env",
            "POSTGRES_PASSWORD=reader_it",
            "--env",
            "POSTGRES_DB=reader_it",
            "postgres:16",
        ]);
        if (usesRedis) {
            await run("docker", [
                "run",
                "--rm",
                "--detach",
                "--name",
                redisName,
                "--publish",
                "127.0.0.1::6379",
                "redis:7-alpine",
            ]);
        }
        const postgresPort = (
            await run("docker", ["port", postgresName, "5432/tcp"])
        )
            .split(":")
            .at(-1);
        const redisPort = usesRedis
            ? (await run("docker", ["port", redisName, "6379/tcp"]))
                  .split(":")
                  .at(-1)
            : undefined;
        if (!postgresPort || (usesRedis && !redisPort)) {
            throw new Error("Docker did not report dynamically assigned ports");
        }

        await waitFor(
            "PostgreSQL readiness",
            () =>
                spawnSync(
                    "docker",
                    [
                        "exec",
                        postgresName,
                        "pg_isready",
                        "-U",
                        "reader_it",
                        "-d",
                        "reader_it",
                    ],
                    { encoding: "utf8", timeout: 1_000 }
                ).status === 0
        );
        if (usesRedis) {
            await waitFor(
                "Redis readiness",
                () =>
                    spawnSync(
                        "docker",
                        ["exec", redisName, "redis-cli", "ping"],
                        {
                            encoding: "utf8",
                            timeout: 1_000,
                        }
                    ).stdout?.trim() === "PONG"
            );
        }

        if (process.env.READER_IT_SIGNAL_PROBE === "1") {
            await new Promise((resolvePromise) => {
                resolveSignalProbe = resolvePromise;
                signalProbeKeepAlive = setInterval(() => {}, 1_000);
                console.log("SIGNAL_PROBE_READY");
            });
            clearInterval(signalProbeKeepAlive);
            signalProbeKeepAlive = undefined;
            if (receivedSignal) {
                throw new Error(
                    `Integration harness received ${receivedSignal}`
                );
            }
        }

        const databaseUrl = `postgres://reader_it:reader_it@127.0.0.1:${postgresPort}/reader_it`;
        const integrationEnv = {
            ...process.env,
            DATABASE_URL: databaseUrl,
            REDIS_URL: redisPort ? `redis://127.0.0.1:${redisPort}` : "",
            JWT_SECRET: "reader-integration-test-secret",
            ...(suite === "auth"
                ? {
                      NODE_ENV: "test",
                      DEV_USER_EMAIL: "reader-auth-integration@example.invalid",
                      DEV_USER_NAME: "Auth Integration",
                  }
                : {}),
            ...(suite === "journeys"
                ? {
                      NODE_ENV: "test",
                      STORAGE_DRIVER: "local",
                      LOCAL_STORAGE_DIR: `.tmp/reader-it-storage-${suffix}`,
                      RAG_RERANK_SHADOW_SAMPLE_RATE: "1",
                  }
                : {}),
            FRONTEND_URL: "http://localhost:5173",
            DOTENV_CONFIG_PATH: "/dev/null",
            NODE_PATH: [
                resolve(root, "apps/api/node_modules"),
                resolve(root, "apps/worker/node_modules"),
                resolve(root, "packages/jobs/node_modules"),
                process.env.NODE_PATH,
            ]
                .filter(Boolean)
                .join(delimiter),
        };
        localStoragePath = integrationEnv.LOCAL_STORAGE_DIR
            ? resolve(root, integrationEnv.LOCAL_STORAGE_DIR)
            : undefined;
        await run("pnpm", ["--filter", "@reader/api", "prebuild"], {
            env: integrationEnv,
        });
        await run(
            "pnpm",
            ["exec", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
            { env: integrationEnv }
        );

        if (suite === "progress") {
            await run("docker", [
                "exec",
                postgresName,
                "createdb",
                "-U",
                "reader_it",
                upgradeDatabaseName,
            ]);
            upgradeDatabaseUrl = databaseUrl.replace(
                /\/reader_it$/,
                `/${upgradeDatabaseName}`
            );
            const journal = JSON.parse(
                readFileSync(
                    resolve(root, "apps/api/migrations/meta/_journal.json"),
                    "utf8"
                )
            );
            const previousEntries = journal.entries.slice(0, -1);
            mkdirSync(resolve(upgradeMigrationDir, "meta"), {
                recursive: true,
            });
            for (const entry of previousEntries) {
                copyFileSync(
                    resolve(root, `apps/api/migrations/${entry.tag}.sql`),
                    resolve(upgradeMigrationDir, `${entry.tag}.sql`)
                );
            }
            writeFileSync(
                resolve(upgradeMigrationDir, "meta/_journal.json"),
                JSON.stringify(
                    { ...journal, entries: previousEntries },
                    null,
                    2
                )
            );
            writeFileSync(
                upgradeConfigPath,
                `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ out: ${JSON.stringify(upgradeMigrationDir)}, schema: ${JSON.stringify(resolve(root, "apps/api/src/db/schema.ts"))}, dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL! } });\n`
            );
            await run(
                "pnpm",
                [
                    "exec",
                    "drizzle-kit",
                    "migrate",
                    `--config=${upgradeConfigPath}`,
                ],
                {
                    env: {
                        ...integrationEnv,
                        DATABASE_URL: upgradeDatabaseUrl,
                    },
                }
            );
        }

        rmSync(resolve(root, ".tmp/apps-api-integration"), {
            recursive: true,
            force: true,
        });
        await run(
            "pnpm",
            ["exec", "tsc", "-p", "apps/api/tsconfig.integration.json"],
            {
                env: integrationEnv,
            }
        );
        if (suite === "rag" || suite === "journeys") {
            await run("pnpm", ["--filter", "@reader/worker", "build"], {
                env: integrationEnv,
            });
        }
        const testOutput = await run("node", ["--test", integrationTest], {
            env: {
                ...integrationEnv,
                ...(upgradeDatabaseUrl
                    ? { PROGRESS_UPGRADE_DATABASE_URL: upgradeDatabaseUrl }
                    : {}),
            },
        });
        if (
            !new RegExp(`\\bpass\\s+${expectedPasses}\\b`).test(testOutput) ||
            !/\bfail\s+0\b/.test(testOutput)
        ) {
            throw new Error(
                `Integration suite did not report all ${expectedPasses} scenarios passing`
            );
        }
    } catch (error) {
        if (receivedSignal) {
            process.exitCode = 128 + (receivedSignal === "SIGINT" ? 2 : 15);
        } else if (
            error?.message?.toLowerCase().includes("docker") ||
            error?.message?.includes("Timed out waiting") ||
            error?.message?.includes("Docker did not report")
        ) {
            blockedReason = error.message;
        } else {
            throw error;
        }
    }
} finally {
    clearInterval(signalProbeKeepAlive);
    await cleanup(redisName);
    if (upgradeDatabaseUrl) {
        try {
            await run(
                "docker",
                [
                    "exec",
                    postgresName,
                    "dropdb",
                    "--if-exists",
                    "-U",
                    "reader_it",
                    upgradeDatabaseName,
                ],
                { allowAfterSignal: true }
            );
        } catch {}
    }
    rmSync(upgradeMigrationDir, { recursive: true, force: true });
    rmSync(upgradeConfigPath, { force: true });
    if (localStoragePath)
        rmSync(localStoragePath, { recursive: true, force: true });
    await cleanup(postgresName);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
}

if (blockedReason) {
    console.error(`BLOCKED: ${blockedReason}`);
    process.exitCode = 2;
}
if (receivedSignal) {
    process.exitCode = 128 + (receivedSignal === "SIGINT" ? 2 : 15);
}
