import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    FRONTEND_URL,
    JWT_SECRET,
    type HttpParityScenario,
} from "./helpers/httpParity";

type FixtureCapture = {
    id: string;
    status: number;
    headers: Record<string, string | null>;
    cookies: string[];
    body: unknown;
    effects: unknown[];
};

type FixtureScenario = HttpParityScenario & { capture: FixtureCapture };

type RunnerResult = {
    id: string;
    env: string;
    intentionalDifference?: string;
    capture?: FixtureCapture;
    unconsumedDbSteps?: number;
    error?: string;
    effects?: unknown[];
};

const resolveFixturePath = () => {
    const candidates = [
        path.resolve(
            __dirname,
            "../../../apps/api/test/fixtures/http-parity.json"
        ),
        path.resolve(process.cwd(), "test/fixtures/http-parity.json"),
        path.resolve(process.cwd(), "apps/api/test/fixtures/http-parity.json"),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
        throw new Error(
            `http-parity fixture not found; tried ${candidates.join(", ")}`
        );
    }
    return found;
};

const FIXTURE_PATH = resolveFixturePath();
const API_DIR = path.resolve(path.dirname(FIXTURE_PATH), "..", "..");
const REPO_ROOT = path.resolve(API_DIR, "..", "..");
const RUNNER_PATH = path.join(__dirname, "helpers", "httpParityRunner.js");

const nodePathEntries = [
    path.join(API_DIR, "node_modules"),
    path.join(REPO_ROOT, "packages", "processing", "node_modules"),
    ...(process.env.NODE_PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(process.cwd(), entry)),
].filter((entry, index, list) => list.indexOf(entry) === index);

const childEnv = (envName: string): NodeJS.ProcessEnv =>
    ({
        PATH: process.env.PATH ?? "",
        NODE_PATH: nodePathEntries.join(path.delimiter),
        NODE_ENV: envName,
        JWT_SECRET,
        FRONTEND_URL,
        GOOGLE_CLIENT_ID: "parity-test-google-client-id",
        GOOGLE_CLIENT_SECRET: "parity-test-google-client-secret",
        LANGFUSE_SAMPLE_RATE: "0",
        DATABASE_URL: "postgres://test:test@127.0.0.1:1/test",
        REDIS_URL: "",
        DOTENV_CONFIG_PATH: "/dev/null",
    }) as unknown as NodeJS.ProcessEnv;

const CHILD_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 65_000;
const OUTPUT_TAIL_LIMIT = 64 * 1024;

type RunnerOutput = { nodeEnv: string; results: RunnerResult[] };

const runChild = async (
    envName: "test" | "production",
    signal?: AbortSignal
): Promise<RunnerOutput> => {
    const workdir = fs.mkdtempSync(
        path.join(os.tmpdir(), `reader-parity-${envName}-`)
    );
    const outPath = path.join(workdir, "results.json");
    try {
        return await new Promise<RunnerOutput>((resolve, reject) => {
            const child = spawn(
                process.execPath,
                [RUNNER_PATH, FIXTURE_PATH, outPath, envName],
                {
                    env: childEnv(envName),
                    cwd: workdir,
                    timeout: CHILD_TIMEOUT_MS,
                    killSignal: "SIGKILL",
                }
            );
            let stdout = "";
            let stderr = "";
            const appendTail = (current: string, chunk: Buffer) =>
                (current + chunk.toString("utf8")).slice(-OUTPUT_TAIL_LIMIT);
            child.stdout!.on("data", (chunk: Buffer) => {
                stdout = appendTail(stdout, chunk);
            });
            child.stderr!.on("data", (chunk: Buffer) => {
                stderr = appendTail(stderr, chunk);
            });
            const killOnAbort = () => {
                if (!child.killed) child.kill("SIGKILL");
            };
            signal?.addEventListener("abort", killOnAbort, { once: true });
            const detachAbort = () => {
                signal?.removeEventListener("abort", killOnAbort);
            };
            child.on("error", (error) => {
                detachAbort();
                reject(
                    new Error(
                        `parity runner (${envName}) failed to spawn: ${error.message}`
                    )
                );
            });
            child.on("close", (code, killSignalName) => {
                detachAbort();
                let output: RunnerOutput | undefined;
                let readError: unknown;
                if (fs.existsSync(outPath)) {
                    try {
                        output = JSON.parse(
                            fs.readFileSync(outPath, "utf8")
                        ) as RunnerOutput;
                    } catch (error) {
                        readError = error;
                    }
                }
                if (code === 0 && output) {
                    resolve(output);
                    return;
                }
                const detail = output
                    ? `wrote ${output.results.length} result(s) before failing`
                    : readError
                      ? `results unreadable: ${(readError as Error).message}`
                      : "no results written";
                reject(
                    new Error(
                        `parity runner (${envName}) exited code=${code} signal=${
                            killSignalName ?? "none"
                        } (${detail})\nstderr tail:\n${stderr}\nstdout tail:\n${stdout}`
                    )
                );
            });
        });
    } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
    }
};

const expectedCapture = (scenario: FixtureScenario): FixtureCapture => {
    const capture = JSON.parse(
        JSON.stringify(scenario.capture)
    ) as FixtureCapture;
    switch (scenario.intentionalDifference) {
        case "unknown-route-json":
            capture.body = {
                message: `Cannot ${scenario.request.method} ${scenario.request.path}`,
                error: "Not Found",
                statusCode: 404,
            };
            capture.headers["content-type"] = "application/json; charset=utf-8";
            capture.headers["x-content-type-options"] = null;
            break;
        case "parser-error-status":
            if (scenario.request.body?.kind === "padded") {
                capture.status = 413;
                capture.body = { error: "Payload too large" };
            } else {
                capture.status = 400;
                capture.body = { error: "Malformed request body" };
            }
            break;
        case "multipart-error-status":
            capture.status = 400;
            capture.body = { error: "Malformed upload" };
            if (scenario.id === "books-post-truncated-multipart") {
                capture.effects = capture.effects.filter(
                    (effect) =>
                        !(
                            effect &&
                            typeof effect === "object" &&
                            (effect as Record<string, unknown>).type ===
                                "process" &&
                            (effect as Record<string, unknown>).event ===
                                "uncaughtException"
                        )
                );
            }
            break;
        default:
            break;
    }
    return capture;
};

const CAPTURE_FIELDS = [
    "status",
    "headers",
    "cookies",
    "body",
    "effects",
] as const;

const compareEnv = async (
    envName: "test" | "production",
    signal?: AbortSignal
) => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8")) as {
        meta: { referenceCommit?: string };
        scenarios: FixtureScenario[];
    };
    assert.equal(
        fixture.meta?.referenceCommit,
        "56ae8954",
        "fixture referenceCommit must stay pinned to 56ae8954"
    );
    assert.equal(
        fixture.scenarios.length,
        78,
        "fixture must contain exactly 78 captures"
    );
    const scenarios = fixture.scenarios.filter(
        (scenario) => scenario.env === envName
    );
    const { results } = await runChild(envName, signal);
    assert.deepStrictEqual(
        results.map((result) => result.id).sort(),
        scenarios.map((scenario) => scenario.id).sort(),
        `runner (${envName}) must report exactly the expected unique scenario ids`
    );
    const byId = new Map<string, RunnerResult>(
        results.map((result): [string, RunnerResult] => [result.id, result])
    );
    const failures: string[] = [];

    for (const scenario of scenarios) {
        const result = byId.get(scenario.id);
        if (!result) {
            failures.push(`${scenario.id}: missing runner result`);
            continue;
        }
        if (result.error || !result.capture) {
            failures.push(
                `${scenario.id}: runner error\n${result.error ?? "no capture"}`
            );
            continue;
        }
        const unconsumed = result.unconsumedDbSteps ?? 0;
        if (unconsumed !== 0) {
            failures.push(
                `${scenario.id}: ${unconsumed} unconsumed scripted db step(s)`
            );
        }
        const actual = result.capture;
        const expected = expectedCapture(scenario);
        for (const field of CAPTURE_FIELDS) {
            try {
                assert.deepStrictEqual(actual[field], expected[field]);
            } catch (error) {
                failures.push(
                    `${scenario.id} ${field} mismatch\n${(error as Error).message}`
                );
            }
        }
        const unexpectedEffects = actual.effects.filter(
            (effect) =>
                effect &&
                typeof effect === "object" &&
                (effect as Record<string, unknown>).unexpected === true
        );
        for (const effect of unexpectedEffects) {
            failures.push(
                `${scenario.id}: unapproved effect ${JSON.stringify(effect)}`
            );
        }
    }

    assert.deepStrictEqual(
        failures,
        [],
        `${failures.length} http parity failure(s) for NODE_ENV=${envName}:\n\n${failures.join("\n\n")}`
    );
};

test(
    "http parity vs frozen reference fixture (NODE_ENV=test)",
    { timeout: TEST_TIMEOUT_MS },
    (t) => compareEnv("test", t.signal)
);

test(
    "http parity vs frozen reference fixture (NODE_ENV=production)",
    { timeout: TEST_TIMEOUT_MS },
    (t) => compareEnv("production", t.signal)
);
