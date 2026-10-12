import { readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const isInside = (parent, child) => {
    const relative = path.relative(parent, child);
    return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
};

const canonicalPath = (fileName) => {
    try {
        return realpathSync.native(fileName);
    } catch {
        return path.resolve(fileName);
    }
};

const importedBindings = (clause) => {
    if (!clause) return [];
    const bindings = [];
    if (clause.name) bindings.push(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push(clause.namedBindings.name.text);
    } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
            bindings.push(element.propertyName?.text ?? element.name.text);
        }
    }
    return bindings;
};

export const collectModuleReferences = (sourceText, fileName) => {
    const source = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true
    );
    const references = [];
    const add = (specifier, node, bindings = []) => {
        references.push({
            specifier,
            line:
                source.getLineAndCharacterOfPosition(node.getStart(source))
                    .line + 1,
            bindings,
        });
    };
    const visit = (node) => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
            if (ts.isStringLiteralLike(node.moduleSpecifier)) {
                add(
                    node.moduleSpecifier.text,
                    node.moduleSpecifier,
                    importedBindings(node.importClause)
                );
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            if (ts.isStringLiteralLike(node.moduleSpecifier)) {
                add(node.moduleSpecifier.text, node.moduleSpecifier);
            }
        } else if (ts.isImportTypeNode(node)) {
            if (
                ts.isLiteralTypeNode(node.argument) &&
                ts.isStringLiteralLike(node.argument.literal)
            ) {
                add(node.argument.literal.text, node.argument.literal);
            } else {
                add("<non-literal>", node.argument);
            }
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        ) {
            const expression = node.moduleReference.expression;
            if (expression && ts.isStringLiteralLike(expression)) {
                add(expression.text, expression, [node.name.text]);
            } else if (expression) {
                add("<non-literal>", expression, [node.name.text]);
            }
        } else if (ts.isCallExpression(node)) {
            const callee = node.expression;
            const isRequire =
                (ts.isIdentifier(callee) && callee.text === "require") ||
                (ts.isPropertyAccessExpression(callee) &&
                    callee.name.text === "require") ||
                (ts.isPropertyAccessExpression(callee) &&
                    ts.isIdentifier(callee.expression) &&
                    callee.expression.text === "require" &&
                    callee.name.text === "resolve");
            if (isRequire || callee.kind === ts.SyntaxKind.ImportKeyword) {
                const argument = node.arguments[0];
                if (argument && ts.isStringLiteralLike(argument)) {
                    add(argument.text, argument);
                } else {
                    add(
                        argument?.getText(source) ?? "<missing>",
                        argument ?? node
                    );
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return references;
};

export const findImportViolations = (sourceText, fileName, rules) => {
    const filePath = path.resolve(fileName);
    const isTest = isInside(path.resolve(rules.packageRoot, "test"), filePath);
    const violations = [];
    for (const reference of collectModuleReferences(sourceText, fileName)) {
        const { specifier, line } = reference;
        if (specifier === "<non-literal>" || specifier.startsWith("<")) {
            violations.push({ file: fileName, line, specifier });
            continue;
        }
        if (rules.resolveModule) {
            const resolved = rules.resolveModule(specifier, filePath);
            if (
                (rules.allowNodeBuiltins && specifier.startsWith("node:")) ||
                (isTest && specifier.startsWith("node:"))
            ) {
                continue;
            }
            const resolvedPath = resolved && canonicalPath(resolved);
            const allowedRoots = [
                rules.packageRoot,
                ...(rules.allowedPackageRoots ?? []),
            ].map(canonicalPath);
            if (
                !resolvedPath ||
                !allowedRoots.some((root) => isInside(root, resolvedPath))
            ) {
                violations.push({ file: fileName, line, specifier });
            }
            continue;
        }

        if (specifier.startsWith(".")) {
            const resolved = path.resolve(path.dirname(filePath), specifier);
            if (!isInside(path.resolve(rules.packageRoot), resolved)) {
                violations.push({ file: fileName, line, specifier });
            }
            continue;
        }
        if (
            (rules.allowNodeBuiltins && specifier.startsWith("node:")) ||
            (isTest && specifier.startsWith("node:")) ||
            (isTest &&
                (specifier === rules.packageName ||
                    specifier === "@reader/domain")) ||
            (!isTest &&
                rules.packageName === "@reader/application" &&
                specifier === "@reader/domain")
        ) {
            continue;
        }
        violations.push({ file: fileName, line, specifier });
    }
    return violations;
};

export const findManifestViolations = (packageName, manifest) => {
    const dependencies = {
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
    };
    const valid =
        packageName === "@reader/domain"
            ? Object.keys(dependencies).length === 0
            : packageName === "@reader/application"
              ? Object.keys(dependencies).length === 1 &&
                dependencies["@reader/domain"]?.startsWith("workspace:")
              : true;
    return valid ? [] : ["invalid runtime dependencies"];
};

export const findWorkspaceCycles = (manifests) => {
    const packages = new Map(
        manifests.map((manifest) => [manifest.name, manifest])
    );
    const edges = new Map();
    for (const manifest of manifests) {
        const dependencies = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
        };
        edges.set(
            manifest.name,
            Object.entries(dependencies)
                .filter(
                    ([name, version]) =>
                        version.startsWith("workspace:") && packages.has(name)
                )
                .map(([name]) => name)
                .sort()
        );
    }

    const state = new Map();
    const stack = [];
    const cycles = [];
    const seen = new Set();
    const visit = (name) => {
        state.set(name, 1);
        stack.push(name);
        for (const dependency of edges.get(name) ?? []) {
            if (!state.has(dependency)) {
                visit(dependency);
            } else if (state.get(dependency) === 1) {
                const start = stack.indexOf(dependency);
                const cycle = [...stack.slice(start), dependency];
                const key = cycle.join(" -> ");
                if (!seen.has(key)) {
                    seen.add(key);
                    cycles.push(cycle);
                }
            }
        }
        stack.pop();
        state.set(name, 2);
    };
    for (const name of [...packages.keys()].sort()) {
        if (!state.has(name)) visit(name);
    }
    return cycles;
};

const packageNameFromSpecifier = (specifier) => {
    if (specifier.startsWith("@")) {
        return specifier.split("/").slice(0, 2).join("/");
    }
    return specifier.split("/")[0];
};

export const findTransportViolations = (
    sourceText,
    fileName,
    { apiSrcRoot, resolveModule } = {}
) => {
    const violations = [];
    const apiRoot = apiSrcRoot && canonicalPath(apiSrcRoot);
    for (const reference of collectModuleReferences(sourceText, fileName)) {
        const { specifier, line, bindings } = reference;
        const packageName = packageNameFromSpecifier(specifier);
        const resolved = resolveModule?.(specifier, path.resolve(fileName));
        const resolvedPath = resolved && canonicalPath(resolved);
        const normalized = specifier.replaceAll("\\", "/");
        let reason;

        if (
            [
                "drizzle-orm",
                "openai",
                "google-auth-library",
                "jsonwebtoken",
                "chromadb",
                "bullmq",
                "ioredis",
                "minisearch",
            ].includes(packageName) ||
            packageName.startsWith("langfuse") ||
            packageName.startsWith("@aws-sdk/")
        ) {
            reason = "SDK or persistence client import";
        } else if (
            bindings.includes("DRIZZLE") ||
            /(^|\/)db(\/schema)?(\/|$)/.test(normalized) ||
            normalized.includes("database/database.module") ||
            (resolvedPath &&
                apiRoot &&
                (isInside(path.join(apiRoot, "db"), resolvedPath) ||
                    isInside(path.join(apiRoot, "database"), resolvedPath) ||
                    path.basename(resolvedPath).startsWith("database.module.")))
        ) {
            reason = "database module or schema import";
        } else if (
            normalized.includes("/services/") ||
            normalized.startsWith("services/") ||
            (resolvedPath &&
                apiRoot &&
                isInside(path.join(apiRoot, "services"), resolvedPath))
        ) {
            reason = "legacy src/services import";
        }

        if (reason) {
            violations.push({ file: fileName, line, specifier, reason });
        }
    }
    return violations;
};

const collectTypeScriptFiles = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTypeScriptFiles(fullPath));
        } else if (entry.isFile() && fullPath.endsWith(".ts")) {
            files.push(fullPath);
        }
    }
    return files;
};

const readWorkspaceManifests = (root) =>
    ["apps", "packages"].flatMap((folder) =>
        readdirSync(path.join(root, folder), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => {
                const file = path.join(
                    root,
                    folder,
                    entry.name,
                    "package.json"
                );
                const manifest = JSON.parse(readFileSync(file, "utf8"));
                return { ...manifest, file };
            })
    );

const createResolver = (
    packageRoot,
    configPath,
    baseUrl,
    workspacePathMappings = {}
) => {
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) {
        throw new Error(
            ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
        );
    }
    const parsed = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        path.dirname(configPath),
        undefined,
        configPath
    );
    const options = {
        ...parsed.options,
        baseUrl,
        paths: {
            ...parsed.options.paths,
            ...workspacePathMappings,
        },
    };
    const cache = ts.createModuleResolutionCache(
        packageRoot,
        (fileName) => fileName,
        options
    );
    return (specifier, importer) => {
        const result = ts.resolveModuleName(
            specifier,
            importer,
            options,
            ts.sys,
            cache
        ).resolvedModule;
        return result?.resolvedFileName;
    };
};

export const TRANSPORT_ALLOWLIST = [];

const runArchitectureCheck = () => {
    const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        ".."
    );
    const domainRoot = path.join(root, "packages/domain");
    const applicationRoot = path.join(root, "packages/application");
    const packages = [
        {
            packageName: "@reader/domain",
            packageRoot: domainRoot,
            srcRoot: path.join(domainRoot, "src"),
        },
        {
            packageName: "@reader/application",
            packageRoot: applicationRoot,
            srcRoot: path.join(applicationRoot, "src"),
            allowedPackageRoots: [domainRoot],
        },
    ];
    const workspacePathMappings = {
        "@reader/domain": ["packages/domain/src/index.ts"],
        "@reader/domain/*": ["packages/domain/src/*"],
        "@reader/application": ["packages/application/src/index.ts"],
        "@reader/application/*": ["packages/application/src/*"],
    };
    const violations = [];
    let coreFileCount = 0;

    for (const rules of packages) {
        const resolver = createResolver(
            rules.packageRoot,
            path.join(rules.packageRoot, "tsconfig.json"),
            root,
            workspacePathMappings
        );
        const resolvedRules = { ...rules, resolveModule: resolver };
        for (const directoryName of ["src", "test"]) {
            const directory = path.join(rules.packageRoot, directoryName);
            for (const file of collectTypeScriptFiles(directory)) {
                coreFileCount += 1;
                violations.push(
                    ...findImportViolations(
                        readFileSync(file, "utf8"),
                        file,
                        resolvedRules
                    )
                );
            }
        }

        const manifest = JSON.parse(
            readFileSync(path.join(rules.packageRoot, "package.json"), "utf8")
        );
        for (const issue of findManifestViolations(
            rules.packageName,
            manifest
        )) {
            violations.push({
                file: path.join(rules.packageRoot, "package.json"),
                line: 1,
                specifier: issue,
            });
        }
    }

    const workspaceManifests = readWorkspaceManifests(root);
    for (const cycle of findWorkspaceCycles(workspaceManifests)) {
        violations.push({
            file: path.join(root, "pnpm-workspace.yaml"),
            line: 1,
            specifier: `workspace cycle: ${cycle.join(" -> ")}`,
        });
    }

    const apiRoot = path.join(root, "apps/api/src");
    const apiTsconfig = path.join(root, "apps/api/tsconfig.json");
    const resolveApiImport = createResolver(
        path.join(root, "apps/api"),
        apiTsconfig,
        root
    );
    const transports = collectTypeScriptFiles(apiRoot).filter((file) => {
        const relative = path.relative(apiRoot, file).split(path.sep);
        return (
            file.endsWith(".controller.ts") ||
            (relative[0] === "common" &&
                relative[1] === "guards" &&
                relative.length === 3)
        );
    });
    const matchedAllowlist = new Set();
    let transportCount = 0;
    for (const file of transports) {
        transportCount += 1;
        const fileViolations = findTransportViolations(
            readFileSync(file, "utf8"),
            file,
            { apiSrcRoot: apiRoot, resolveModule: resolveApiImport }
        );
        for (const violation of fileViolations) {
            const relativeFile = path
                .relative(root, violation.file)
                .split(path.sep)
                .join("/");
            const allowedIndex = TRANSPORT_ALLOWLIST.findIndex(
                (entry) =>
                    entry.file === relativeFile &&
                    entry.specifier === violation.specifier
            );
            if (allowedIndex >= 0) {
                matchedAllowlist.add(allowedIndex);
            } else {
                violations.push(violation);
            }
        }
    }
    TRANSPORT_ALLOWLIST.forEach((entry, index) => {
        if (!matchedAllowlist.has(index)) {
            violations.push({
                file: path.join(root, entry.file),
                line: 1,
                specifier: `stale transport allowlist entry: ${entry.specifier} (${entry.reason})`,
            });
        }
    });

    if (violations.length) {
        for (const violation of violations) {
            console.error(
                `${path.relative(root, violation.file)}:${violation.line}: ${violation.specifier}${violation.reason ? ` — ${violation.reason}` : ""}`
            );
        }
        process.exitCode = 1;
    } else {
        console.log(
            `Architecture check passed (${coreFileCount} core files, ${transportCount} thin transports, ${workspaceManifests.length} workspace packages; transport allowlist: ${TRANSPORT_ALLOWLIST.length}).`
        );
    }
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    runArchitectureCheck();
}
