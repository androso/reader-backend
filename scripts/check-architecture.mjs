import { readFileSync, readdirSync } from "node:fs";
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

export const findImportViolations = (sourceText, fileName, rules) => {
    const source = ts.createSourceFile(
        fileName,
        sourceText,
        ts.ScriptTarget.Latest,
        true
    );
    const filePath = path.resolve(fileName);
    const isTest = isInside(path.resolve(rules.packageRoot, "test"), filePath);
    const violations = [];
    const addViolation = (specifier, node) => {
        const line =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
        violations.push({ file: fileName, line, specifier });
    };
    const checkSpecifier = (specifier, node) => {
        if (specifier.startsWith(".")) {
            const resolved = path.resolve(path.dirname(filePath), specifier);
            if (!isInside(path.resolve(rules.packageRoot), resolved)) {
                addViolation(specifier, node);
            }
            return;
        }
        if (
            (isTest && specifier.startsWith("node:")) ||
            (isTest &&
                (specifier === rules.packageName ||
                    specifier === "@reader/domain")) ||
            (!isTest &&
                rules.packageName === "@reader/application" &&
                path.resolve(rules.srcRoot) &&
                specifier === "@reader/domain")
        ) {
            return;
        }
        addViolation(specifier, node);
    };

    const visit = (node) => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            checkSpecifier(node.moduleSpecifier.text, node.moduleSpecifier);
        } else if (ts.isImportTypeNode(node)) {
            if (
                ts.isLiteralTypeNode(node.argument) &&
                ts.isStringLiteralLike(node.argument.literal)
            ) {
                checkSpecifier(
                    node.argument.literal.text,
                    node.argument.literal
                );
            } else {
                addViolation("<non-literal>", node.argument);
            }
        } else if (
            ts.isImportEqualsDeclaration(node) &&
            ts.isExternalModuleReference(node.moduleReference)
        ) {
            const expression = node.moduleReference.expression;
            if (expression && ts.isStringLiteralLike(expression)) {
                checkSpecifier(expression.text, expression);
            } else if (expression) {
                addViolation("<non-literal>", expression);
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
            const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
            if (isRequire || isDynamicImport) {
                const argument = node.arguments[0];
                if (argument && ts.isStringLiteralLike(argument)) {
                    checkSpecifier(argument.text, argument);
                } else {
                    addViolation(
                        argument?.getText(source) ?? "<missing>",
                        argument ?? node
                    );
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return violations;
};

const collectTypeScriptFiles = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory())
            files.push(...collectTypeScriptFiles(fullPath));
        else if (entry.isFile() && fullPath.endsWith(".ts"))
            files.push(fullPath);
    }
    return files;
};

const runArchitectureCheck = () => {
    const root = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        ".."
    );
    const packageRules = [
        {
            packageName: "@reader/domain",
            packageRoot: path.join(root, "packages/domain"),
            srcRoot: path.join(root, "packages/domain/src"),
        },
        {
            packageName: "@reader/application",
            packageRoot: path.join(root, "packages/application"),
            srcRoot: path.join(root, "packages/application/src"),
        },
    ];
    const violations = [];

    for (const rules of packageRules) {
        for (const directoryName of ["src", "test"]) {
            const directory = path.join(rules.packageRoot, directoryName);
            for (const file of collectTypeScriptFiles(directory)) {
                const source = readFileSync(file, "utf8");
                violations.push(...findImportViolations(source, file, rules));
            }
        }

        const packageJson = JSON.parse(
            readFileSync(path.join(rules.packageRoot, "package.json"), "utf8")
        );
        const dependencies = packageJson.dependencies ?? {};
        const validDependencies =
            rules.packageName === "@reader/domain"
                ? Object.keys(dependencies).length === 0
                : JSON.stringify(dependencies) ===
                  JSON.stringify({ "@reader/domain": "workspace:*" });
        if (!validDependencies) {
            violations.push({
                file: path.join(rules.packageRoot, "package.json"),
                line: 1,
                specifier: "invalid dependencies",
            });
        }
    }

    if (violations.length) {
        for (const violation of violations) {
            console.error(
                `${path.relative(root, violation.file)}:${violation.line}: ${violation.specifier}`
            );
        }
        process.exitCode = 1;
    } else {
        console.log("Architecture check passed.");
    }
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    runArchitectureCheck();
}
