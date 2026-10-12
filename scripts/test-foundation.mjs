import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const steps = [
    ["Architecture", ["check:architecture"]],
    ["Build", ["build"]],
    ["Root tests", ["test"]],
    [
        "Built-package import safety",
        ["exec", "node", "scripts/test-import-safety.mjs"],
    ],
    ["Web tests", ["--filter", "@reader/web", "test"]],
    ["Books integration", ["test:integration:books"]],
    ["Chat integration", ["test:integration:chat"]],
    ["RAG integration", ["test:integration:rag"]],
    ["Progress integration", ["test:integration:progress"]],
    ["Auth integration", ["test:integration:auth"]],
    ["Offline journeys integration", ["test:integration:journeys"]],
];

for (const [name, args] of steps) {
    console.log(`\n=== Foundation step: ${name} ===`);
    const result = spawnSync("pnpm", args, {
        cwd: root,
        env: process.env,
        stdio: "inherit",
    });
    if (result.error) {
        console.error(
            `Foundation failed at "${name}": ${result.error.message}`
        );
        process.exit(1);
    }
    if (result.status !== 0) {
        console.error(
            `Foundation failed at "${name}" (exit ${result.status ?? "signal"}).`
        );
        process.exit(result.status ?? 1);
    }
}

console.log(`\nFoundation gate passed all ${steps.length} steps.`);
