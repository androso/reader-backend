import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../.."
);
const listContainers = () => {
    const result = spawnSync("docker", ["ps", "-a", "--format", "{{.Names}}"], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
    });
    assert.equal(
        result.status,
        0,
        `Could not inspect Docker containers:\n${result.stderr}`
    );
    return result.stdout
        .split(/\r?\n/)
        .filter((name) => name.startsWith("reader-it-"));
};

const before = new Set(listContainers());
const child = spawn(process.execPath, ["scripts/integration/books.mjs"], {
    cwd: root,
    env: { ...process.env, READER_IT_SIGNAL_PROBE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
    output += chunk;
    process.stderr.write(chunk);
});

let childClosed;
const closed = new Promise((resolve) => {
    child.once("close", (code, signal) => {
        childClosed = { code, signal };
        resolve(childClosed);
    });
});
const waitForReady = new Promise((resolve, reject) => {
    const deadline = setTimeout(
        () =>
            reject(new Error(`Timed out waiting for signal probe:\n${output}`)),
        120_000
    );
    const check = () => {
        if (output.includes("SIGNAL_PROBE_READY")) {
            clearTimeout(deadline);
            resolve();
        } else if (childClosed) {
            clearTimeout(deadline);
            reject(
                new Error(
                    `Signal-probe child exited before readiness: ${JSON.stringify(childClosed)}\n${output}`
                )
            );
        }
    };
    child.stdout.on("data", check);
    child.stderr.on("data", check);
    closed.then(check);
    check();
});

let createdContainers = [];
try {
    await waitForReady;
    assert.equal(child.kill("SIGTERM"), true);
    const result = await new Promise((resolve, reject) => {
        const deadline = setTimeout(
            () => reject(new Error("Timed out waiting for signal cleanup")),
            30_000
        );
        closed.then(
            (value) => {
                clearTimeout(deadline);
                resolve(value);
            },
            (error) => {
                clearTimeout(deadline);
                reject(error);
            }
        );
    });
    assert.equal(
        result.code,
        143,
        `Unexpected child status: ${JSON.stringify(result)}`
    );

    const after = listContainers();
    createdContainers = after.filter((name) => !before.has(name));
    assert.deepEqual(
        createdContainers,
        [],
        "Signal cleanup left integration containers running"
    );
} finally {
    if (!childClosed) {
        child.kill("SIGTERM");
        await new Promise((resolve) => {
            const deadline = setTimeout(resolve, 5_000);
            closed.then(() => {
                clearTimeout(deadline);
                resolve();
            });
        });
        if (!childClosed) {
            child.kill("SIGKILL");
            await Promise.race([
                closed,
                new Promise((resolve) => setTimeout(resolve, 1_000)),
            ]);
        }
    }
    if (!createdContainers.length) {
        try {
            createdContainers = listContainers().filter(
                (name) => !before.has(name)
            );
        } catch {}
    }
    if (createdContainers.length) {
        spawnSync("docker", ["rm", "--force", ...createdContainers], {
            cwd: root,
            encoding: "utf8",
            timeout: 10_000,
        });
    }
}

console.log(
    "Integration signal cleanup passed (SIGTERM left no new reader-it containers)."
);
