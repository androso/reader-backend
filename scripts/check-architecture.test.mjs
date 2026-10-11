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

test("rejects a relative path that escapes the package", () => {
    const violations = findImportViolations(
        'import "../../../apps/api";',
        srcFile,
        rules
    );
    assert.equal(violations.length, 1);
    assert.equal(violations[0].specifier, "../../../apps/api");
});
