import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");

export const services = [
    {
        name: "reader-redis",
        image: "redis:7.4.9-alpine",
        port: "127.0.0.1:6379:6379",
        volume: "reader-redis-data",
        directory: "/data",
        environment: [],
        command: ["redis-server", "--appendonly", "yes"],
    },
    {
        name: "reader-chroma",
        image: "chromadb/chroma:0.6.3",
        port: "127.0.0.1:8000:8000",
        volume: "reader-chroma-data",
        directory: "/chroma/chroma",
        environment: [
            "IS_PERSISTENT=TRUE",
            "PERSIST_DIRECTORY=/chroma/chroma",
            "ANONYMIZED_TELEMETRY=FALSE",
        ],
        command: [],
    },
];

export const setupEnvironment = (directory = root, log = console.log) => {
    for (const relative of [".env", "apps/web/.env"]) {
        const destination = resolve(directory, relative);
        if (existsSync(destination)) {
            log(`Kept existing ${relative}`);
            continue;
        }
        let template = readFileSync(`${destination}.template`, "utf8");
        if (relative === ".env") {
            template = template.replace(
                /^JWT_SECRET=$/m,
                `JWT_SECRET=${randomBytes(32).toString("hex")}`
            );
        }
        writeFileSync(destination, template, { flag: "wx", mode: 0o600 });
        log(`Created ${relative}`);
    }
};

export const docker = (args, { allowFailure = false } = {}) => {
    const result = spawnSync("docker", args, {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) throw new Error(`Docker: ${result.error.message}`);
    if (result.status !== 0 && !allowFailure) {
        throw new Error(result.stderr.trim() || "Docker command failed");
    }
    return { ok: result.status === 0, output: result.stdout.trim() };
};

export const inspectContainer = (name, run = docker) => {
    const result = run(
        ["container", "inspect", name, "--format", "{{json .}}"],
        { allowFailure: true }
    );
    if (result.ok) return JSON.parse(result.output);
    // An unavailable daemon must not be mistaken for a missing container.
    run(["info", "--format", "{{.ServerVersion}}"]);
    return null;
};

export const setupServices = (run = docker, log = console.log) => {
    run(["info", "--format", "{{.ServerVersion}}"]);
    for (const service of services) {
        const existing = inspectContainer(service.name, run);
        let image = run(
            ["image", "inspect", service.image, "--format", "{{.Id}}"],
            { allowFailure: true }
        );
        if (!image.ok) {
            log(`Pulling ${service.image}`);
            run(["pull", service.image]);
            image = run([
                "image",
                "inspect",
                service.image,
                "--format",
                "{{.Id}}",
            ]);
        }
        if (existing) {
            if (
                existing.Image !== image.output ||
                existing.HostConfig.RestartPolicy.Name !== "no"
            ) {
                throw new Error(
                    `${service.name} does not match ${service.image} with restart=no. ` +
                        "Preserve its data and resolve the conflict manually; setup never replaces containers."
                );
            }
            log(`Kept existing ${service.name}`);
            continue;
        }
        run(["volume", "create", service.volume]);
        run([
            "create",
            "--name",
            service.name,
            "--restart=no",
            "--publish",
            service.port,
            "--mount",
            `type=volume,source=${service.volume},target=${service.directory}`,
            ...service.environment.flatMap((value) => ["--env", value]),
            service.image,
            ...service.command,
        ]);
        log(`Created ${service.name} (stopped)`);
    }
};

export const waitForServices = async ({
    run = docker,
    request = fetch,
    pause = (ms) => new Promise((done) => setTimeout(done, ms)),
    attempts = 60,
} = {}) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const redis = run(["exec", "reader-redis", "redis-cli", "PING"], {
                allowFailure: true,
            });
            const chroma = await request(
                "http://127.0.0.1:8000/api/v1/heartbeat",
                {
                    signal: AbortSignal.timeout(2_000),
                }
            );
            const heartbeat = chroma.ok ? await chroma.json() : null;
            if (
                redis.ok &&
                redis.output === "PONG" &&
                typeof heartbeat?.["nanosecond heartbeat"] === "number"
            )
                return;
        } catch {}
        if (attempt + 1 < attempts) await pause(1_000);
    }
    throw new Error(
        "Services did not become ready. Check docker logs reader-redis and docker logs reader-chroma. " +
            "Chroma must support /api/v1 for the current client."
    );
};

export const main = async (command) => {
    if (command === "env") return setupEnvironment();
    if (command === "setup") return setupServices();
    if (command === "up") {
        setupServices();
        docker(["start", ...services.map((service) => service.name)]);
        await waitForServices();
        console.log("Redis and Chroma are ready. PostgreSQL was not changed.");
        return;
    }
    if (command === "down") {
        for (const service of services) {
            const existing = inspectContainer(service.name);
            if (existing?.State.Running) docker(["stop", service.name]);
        }
        console.log("Reader services stopped; containers and data retained.");
        return;
    }
    if (command === "status") {
        for (const name of [
            "postgresql",
            ...services.map((service) => service.name),
        ]) {
            const existing = inspectContainer(name);
            console.log(
                existing
                    ? `${name}: ${existing.State.Status}, ${existing.Config.Image}, restart=${existing.HostConfig.RestartPolicy.Name}`
                    : `${name}: not created`
            );
        }
        return;
    }
    throw new Error("Usage: node scripts/dev.mjs env|setup|up|down|status");
};

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
    main(process.argv[2]).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
