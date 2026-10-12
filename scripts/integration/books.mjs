import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
            : ".tmp/apps-api-integration/test-integration/booksLifecycle.test.js";
const expectedPasses =
    suite === "auth"
        ? 3
        : suite === "chat" ? 3 : suite === "rag" ? 3 : suite === "progress" ? 6 : 10;
const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
const postgresName = `reader-it-postgres-${suffix}`;
const redisName = `reader-it-redis-${suffix}`;
const upgradeDatabaseName = `reader_it_progress_upgrade_${suffix.replaceAll("-", "_")}`;
const upgradeMigrationDir = resolve(root, ".tmp/progress-previous-migrations");
const upgradeConfigPath = resolve(root, ".tmp/progress-previous.drizzle.config.ts");
const usesRedis = suite !== "progress" && suite !== "auth";

const run = (command, args, options = {}) => {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        env: process.env,
        ...options,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (output) process.stdout.write(output);
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} exited with ${result.status ?? "signal"}`
        );
    }
    return result.stdout.trim();
};

const waitFor = async (description, check) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
        try {
            if (check()) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${description}`);
};

const cleanup = (name) => {
    try {
        run("docker", ["rm", "--force", name]);
    } catch {}
};

let blockedReason;
let upgradeDatabaseUrl;
try {
    try {
        run("docker", ["info", "--format", "{{.ServerVersion}}"]);
        run("docker", [
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
            run("docker", [
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
        const postgresPort = run("docker", ["port", postgresName, "5432/tcp"])
            .split(":")
            .at(-1);
        const redisPort = usesRedis
            ? run("docker", ["port", redisName, "6379/tcp"]).split(":").at(-1)
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
                    { encoding: "utf8" }
                ).status === 0
        );
        if (usesRedis) {
            await waitFor(
                "Redis readiness",
                () =>
                    spawnSync("docker", ["exec", redisName, "redis-cli", "ping"], {
                        encoding: "utf8",
                    }).stdout?.trim() === "PONG"
            );
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
        run("pnpm", ["--filter", "@reader/api", "prebuild"], {
            env: integrationEnv,
        });
        run(
            "pnpm",
            ["exec", "drizzle-kit", "migrate", "--config=drizzle.config.ts"],
            { env: integrationEnv }
        );

        if (suite === "progress") {
            run("docker", ["exec", postgresName, "createdb", "-U", "reader_it", upgradeDatabaseName]);
            upgradeDatabaseUrl = databaseUrl.replace(/\/reader_it$/, `/${upgradeDatabaseName}`);
            const journal = JSON.parse(
                readFileSync(resolve(root, "apps/api/migrations/meta/_journal.json"), "utf8")
            );
            const previousEntries = journal.entries.slice(0, -1);
            mkdirSync(resolve(upgradeMigrationDir, "meta"), { recursive: true });
            for (const entry of previousEntries) {
                copyFileSync(
                    resolve(root, `apps/api/migrations/${entry.tag}.sql`),
                    resolve(upgradeMigrationDir, `${entry.tag}.sql`)
                );
            }
            writeFileSync(
                resolve(upgradeMigrationDir, "meta/_journal.json"),
                JSON.stringify({ ...journal, entries: previousEntries }, null, 2)
            );
            writeFileSync(
                upgradeConfigPath,
                `import { defineConfig } from "drizzle-kit";\nexport default defineConfig({ out: ${JSON.stringify(upgradeMigrationDir)}, schema: ${JSON.stringify(resolve(root, "apps/api/src/db/schema.ts"))}, dialect: "postgresql", dbCredentials: { url: process.env.DATABASE_URL! } });\n`
            );
            run("pnpm", ["exec", "drizzle-kit", "migrate", `--config=${upgradeConfigPath}`], {
                env: { ...integrationEnv, DATABASE_URL: upgradeDatabaseUrl },
            });
        }

        rmSync(resolve(root, ".tmp/apps-api-integration"), {
            recursive: true,
            force: true,
        });
        run(
            "pnpm",
            ["exec", "tsc", "-p", "apps/api/tsconfig.integration.json"],
            {
                env: integrationEnv,
            }
        );
        if (suite === "rag") {
            run("pnpm", ["--filter", "@reader/worker", "build"], {
                env: integrationEnv,
            });
        }
        const testOutput = run(
            "node",
            ["--test", integrationTest],
            {
                env: {
                    ...integrationEnv,
                    ...(upgradeDatabaseUrl
                        ? { PROGRESS_UPGRADE_DATABASE_URL: upgradeDatabaseUrl }
                        : {}),
                },
            }
        );
        if (
            !new RegExp(`\\bpass\\s+${expectedPasses}\\b`).test(testOutput) ||
            !/\bfail\s+0\b/.test(testOutput)
        ) {
            throw new Error(
                `Integration suite did not report all ${expectedPasses} scenarios passing`
            );
        }
    } catch (error) {
        if (
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
    cleanup(redisName);
    if (upgradeDatabaseUrl) {
        try {
            run("docker", ["exec", postgresName, "dropdb", "--if-exists", "-U", "reader_it", upgradeDatabaseName]);
        } catch {}
    }
    rmSync(upgradeMigrationDir, { recursive: true, force: true });
    rmSync(upgradeConfigPath, { force: true });
    cleanup(postgresName);
}

if (blockedReason) {
    console.error(`BLOCKED: ${blockedReason}`);
    process.exitCode = 2;
}
