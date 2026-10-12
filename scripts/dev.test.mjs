import assert from "node:assert/strict";
import test from "node:test";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
    inspectContainer,
    services,
    setupEnvironment,
    setupServices,
    waitForServices,
} from "./dev.mjs";

test("environment setup generates a private secret and never overwrites files", () => {
    const root = mkdtempSync(resolve(tmpdir(), "reader-dev-"));
    try {
        mkdirSync(resolve(root, "apps/web"), { recursive: true });
        writeFileSync(
            resolve(root, ".env.template"),
            "JWT_SECRET=\nDATABASE_URL=local\n"
        );
        writeFileSync(
            resolve(root, "apps/web/.env.template"),
            "NEXT_PUBLIC_API_URL=http://localhost:3000\n"
        );
        setupEnvironment(root, () => {});
        const original = readFileSync(resolve(root, ".env"), "utf8");
        assert.match(original, /^JWT_SECRET=[a-f0-9]{64}\n/);
        if (process.platform !== "win32") {
            assert.equal(statSync(resolve(root, ".env")).mode & 0o777, 0o600);
        }
        writeFileSync(resolve(root, "apps/web/.env"), "user configuration");
        setupEnvironment(root, () => {});
        assert.equal(readFileSync(resolve(root, ".env"), "utf8"), original);
        assert.equal(
            readFileSync(resolve(root, "apps/web/.env"), "utf8"),
            "user configuration"
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("fresh setup creates only pinned, manually started Reader services", () => {
    const calls = [];
    const run = (args) => {
        calls.push(args);
        if (args[0] === "container") return { ok: false, output: "" };
        return { ok: true, output: "image-id" };
    };
    setupServices(run, () => {});
    const creates = calls.filter((args) => args[0] === "create");
    assert.equal(creates.length, 2);
    for (const [index, args] of creates.entries()) {
        assert.ok(args.includes(services[index].image));
        assert.ok(args.includes("--restart=no"));
        assert.ok(args.includes(services[index].port));
        assert.ok(
            args.includes(
                `type=volume,source=${services[index].volume},target=${services[index].directory}`
            )
        );
    }
    assert.ok(!calls.some((args) => ["start", "stop", "rm"].includes(args[0])));
    assert.ok(!calls.some((args) => args.includes("postgresql")));
});

test("setup accepts existing containers by image ID without replacing them", () => {
    const calls = [];
    setupServices(
        (args) => {
            calls.push(args);
            return args[0] === "container"
                ? {
                      ok: true,
                      output: JSON.stringify({
                          Image: "image-id",
                          HostConfig: { RestartPolicy: { Name: "no" } },
                      }),
                  }
                : { ok: true, output: "image-id" };
        },
        () => {}
    );
    assert.ok(
        !calls.some((args) =>
            ["create", "rm", "start", "update"].includes(args[0])
        )
    );
});

test("setup rejects image drift and automatic startup without replacing containers", () => {
    for (const [image, policy] of [
        ["wrong-image", "no"],
        ["image-id", "always"],
    ]) {
        const calls = [];
        assert.throws(
            () =>
                setupServices(
                    (args) => {
                        calls.push(args);
                        return args[0] === "container"
                            ? {
                                  ok: true,
                                  output: JSON.stringify({
                                      Image: image,
                                      HostConfig: {
                                          RestartPolicy: { Name: policy },
                                      },
                                  }),
                              }
                            : { ok: true, output: "image-id" };
                    },
                    () => {}
                ),
            /resolve the conflict manually/
        );
        assert.ok(
            !calls.some((args) =>
                ["create", "rm", "stop", "update"].includes(args[0])
            )
        );
    }
});

test("setup pulls missing pinned images before creating containers", () => {
    const calls = [];
    const pulled = new Set();
    setupServices(
        (args) => {
            calls.push(args);
            if (args[0] === "container") return { ok: false, output: "" };
            if (args[0] === "pull") pulled.add(args[1]);
            if (args[0] === "image")
                return { ok: pulled.has(args[2]), output: "image-id" };
            return { ok: true, output: "" };
        },
        () => {}
    );
    assert.deepEqual(
        calls.filter((args) => args[0] === "pull").map((args) => args[1]),
        services.map((service) => service.image)
    );
});

test("an unavailable daemon is not treated as a missing container", () => {
    assert.throws(
        () =>
            inspectContainer("reader-redis", (args) => {
                if (args[0] === "info") throw new Error("daemon unavailable");
                return { ok: false, output: "" };
            }),
        /daemon unavailable/
    );
});

test("readiness requires Redis PONG and a valid v1 Chroma heartbeat", async () => {
    let requests = 0;
    await waitForServices({
        run: () => ({ ok: true, output: "PONG" }),
        request: async () => {
            requests += 1;
            return requests === 1
                ? { ok: false }
                : {
                      ok: true,
                      json: async () => ({ "nanosecond heartbeat": 123 }),
                  };
        },
        pause: async () => {},
        attempts: 2,
    });
    assert.equal(requests, 2);
});

test("readiness fails within the configured bound for incompatible Chroma", async () => {
    await assert.rejects(
        waitForServices({
            run: () => ({ ok: true, output: "PONG" }),
            request: async () => ({ ok: false }),
            pause: async () => {},
            attempts: 2,
        }),
        /Chroma must support \/api\/v1/
    );
});
