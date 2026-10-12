import assert from "node:assert/strict";
import test from "node:test";
import {
    findImportViolations,
    findManifestViolations,
    findTransportViolations,
    findWorkspaceCycles,
} from "./check-architecture.mjs";

const rules = {
    packageName: "@reader/application",
    packageRoot: "/repo/packages/application",
    srcRoot: "/repo/packages/application/src",
};
const srcFile = "/repo/packages/application/src/example.ts";
const testFile = "/repo/packages/application/test/example.test.ts";

test("checks imports, re-exports, import equals, require, and dynamic import", () => {
    const source = [
        'import type { X } from "@nestjs/common";',
        'export { X } from "@reader/api";',
        'export * from "drizzle-orm";',
        'import X = require("bullmq");',
        'require("fs");',
        'import("apps/api");',
    ].join("\n");
    assert.deepEqual(
        findImportViolations(source, srcFile, rules).map(
            (item) => item.specifier
        ),
        [
            "@nestjs/common",
            "@reader/api",
            "drizzle-orm",
            "bullmq",
            "fs",
            "apps/api",
        ]
    );
});

test("checks inline import types and member require calls", () => {
    const source = [
        'export type Bus = import("node:events").EventEmitter;',
        'type Q = typeof import("bullmq");',
        'const fs = module.require("node:fs");',
        'require.resolve("drizzle-orm");',
    ].join("\n");
    assert.deepEqual(
        findImportViolations(source, srcFile, rules).map(
            (item) => item.specifier
        ),
        ["node:events", "bullmq", "node:fs", "drizzle-orm"]
    );
});

test("allows imports inside the package and the application domain dependency", () => {
    assert.deepEqual(
        findImportViolations(
            'import { Book } from "./internal";\nimport type { X } from "@reader/domain";',
            srcFile,
            rules
        ),
        []
    );
});

test("allows local and application domain inline import types", () => {
    assert.deepEqual(
        findImportViolations(
            'type B = import("./internal").Book;\ntype D = import("@reader/domain").Book;',
            srcFile,
            rules
        ),
        []
    );
});

test("allows test-only node builtins and package imports", () => {
    assert.deepEqual(
        findImportViolations(
            'import test from "node:test";\nimport "@reader/domain";\nimport "@reader/application";',
            testFile,
            rules
        ),
        []
    );
});

test("rejects non-literal require and dynamic import arguments", () => {
    const violations = findImportViolations(
        "require(name);\nimport(getModule());",
        srcFile,
        rules
    );
    assert.deepEqual(
        violations.map((item) => item.specifier),
        ["name", "getModule()"]
    );
});

test("rejects a non-literal inline import type", () => {
    const violations = findImportViolations(
        "type X = import(name).Y;",
        srcFile,
        rules
    );
    assert.deepEqual(
        violations.map((item) => item.specifier),
        ["<non-literal>"]
    );
});

test("rejects a relative path that escapes the package", () => {
    const violations = findImportViolations(
        'import "../../../apps/api";',
        srcFile,
        rules
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, "../../../apps/api");
});

test("rejects forbidden runtime manifest dependencies", () => {
    assert.deepEqual(
        findManifestViolations("@reader/domain", {
            dependencies: { zod: "^3.0.0" },
        }),
        ["invalid runtime dependencies"]
    );
    assert.deepEqual(
        findManifestViolations("@reader/domain", {
            optionalDependencies: { zod: "^3.0.0" },
        }),
        ["invalid runtime dependencies"]
    );
    assert.deepEqual(
        findManifestViolations("@reader/application", {
            dependencies: {
                "@reader/domain": "workspace:*",
                "@reader/providers": "workspace:*",
            },
        }),
        ["invalid runtime dependencies"]
    );
});

test("rejects an alias that resolves outside the application package", () => {
    const violations = findImportViolations(
        'export { retrieve } from "@reader/api/rag";',
        srcFile,
        {
            ...rules,
            allowedPackageRoots: ["/repo/packages/domain"],
            resolveModule: () => "/repo/apps/api/src/rag/index.ts",
        }
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, "@reader/api/rag");
});

test("reports workspace cycles with their full path", () => {
    const cycles = findWorkspaceCycles([
        {
            name: "pkg-a",
            dependencies: { "pkg-b": "workspace:*" },
            devDependencies: {},
        },
        {
            name: "pkg-b",
            dependencies: {},
            devDependencies: { "pkg-a": "workspace:*" },
        },
    ]);
    assert.deepEqual(cycles, [["pkg-a", "pkg-b", "pkg-a"]]);
});

test("rejects all forbidden persistence, SDK, and legacy service imports from thin transports", () => {
    const specifiers = [
        "drizzle-orm",
        "../db/schema",
        "../../database/database.module",
        "openai",
        "google-auth-library",
        "jsonwebtoken",
        "chromadb",
        "bullmq",
        "ioredis",
        "langfuse-node",
        "@aws-sdk/client-s3",
        "minisearch",
        "../../services/RagPipeline",
    ];
    const violations = findTransportViolations(
        specifiers.map((specifier) => `import "${specifier}";`).join("\n"),
        "/repo/apps/api/src/books/example.controller.ts",
        { apiSrcRoot: "/repo/apps/api/src" }
    );
    assert.deepEqual(
        violations.map(({ specifier }) => specifier),
        specifiers
    );
});

test("rejects database token imports from thin transports", () => {
    const violations = findTransportViolations(
        'import { DRIZZLE } from "../../database/database.module";',
        "/repo/apps/api/src/common/guards/example.ts",
        { apiSrcRoot: "/repo/apps/api/src" }
    );
    assert.deepEqual(
        violations.map(({ specifier }) => specifier),
        ["../../database/database.module"]
    );
});

test("rejects transport aliases resolving into database modules or legacy services", () => {
    const resolvedModules = new Map([
        ["@database", "/repo/apps/api/src/database/index.ts"],
        ["@services", "/repo/apps/api/src/services/RagPipeline.ts"],
    ]);
    const violations = findTransportViolations(
        'import { DatabaseModule } from "@database";\nimport { retrieve } from "@services";',
        "/repo/apps/api/src/common/guards/example.ts",
        {
            apiSrcRoot: "/repo/apps/api/src",
            resolveModule: (specifier) => resolvedModules.get(specifier),
        }
    );
    assert.deepEqual(
        violations.map(({ specifier }) => specifier),
        ["@database", "@services"]
    );
});
