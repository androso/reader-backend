import assert from "node:assert/strict";
import test from "node:test";
import { findImportViolations } from "./check-architecture.mjs";

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
