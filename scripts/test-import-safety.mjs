import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const networkBlock = `
const net = require("node:net");
const tls = require("node:tls");
const http = require("node:http");
const https = require("node:https");
const blocked = () => { throw new Error("network access during import"); };
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
globalThis.fetch = blocked;
if ("WebSocket" in globalThis) globalThis.WebSocket = blocked;
`;

const runChild = (cwd, body, env) => {
    const result = spawnSync(
        process.execPath,
        ["-e", `${networkBlock}\n${body}`],
        { cwd, encoding: "utf8", env, timeout: 20_000 }
    );
    assert.equal(
        result.status,
        0,
        `Import-safety child failed in ${cwd}:\n${result.stdout}\n${result.stderr}`
    );
};

const minimalEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "test",
};
runChild(
    path.join(root, "apps/api"),
    `
      require("@reader/domain");
      require("@reader/application");
    `,
    minimalEnv
);

const apiDummyEnv = {
    ...minimalEnv,
    DATABASE_URL: "postgresql://reader:reader@127.0.0.1:1/reader_import_test",
    REDIS_URL: "redis://127.0.0.1:1",
    OPENAI_API_KEY: "import-safety-test",
    GOOGLE_CLIENT_ID: "import-safety-test",
    GOOGLE_CLIENT_SECRET: "import-safety-test",
    JWT_SECRET: "import-safety-test",
    CHROMA_URL: "http://127.0.0.1:1",
    AWS_ACCESS_KEY_ID: "import-safety-test",
    AWS_SECRET_ACCESS_KEY: "import-safety-test",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    LANGFUSE_PUBLIC_KEY: "import-safety-test",
    LANGFUSE_SECRET_KEY: "import-safety-test",
    LANGFUSE_BASE_URL: "http://127.0.0.1:1",
};
const barrelExpectations = {
    rag: ["retrieveBookContext", "retrieveBookEvidence", "generateBookAnswer"],
    "ai-usage": ["AI_PRICING_VERSION", "estimateModelCost"],
    "book-processing": ["processUploadedBook"],
    "rag-shadow": ["processRagRerankShadow", "RagShadowAuthorizationError"],
};
const barrelChecks = Object.entries(barrelExpectations)
    .map(
        ([barrel, names]) =>
            `{
              const specifier = "@reader/api/${barrel}";
              const resolved = contextRequire.resolve(specifier);
              const loaded = contextRequire(resolved);
              for (const name of ${JSON.stringify(names)}) {
                if (!(name in loaded)) throw new Error("Missing export ${barrel}." + name);
              }
            }`
    )
    .join("\n");

for (const context of ["apps/worker", "packages/evals"]) {
    const contextPath = path.join(root, context);
    runChild(
        contextPath,
        `
          const { createRequire } = require("node:module");
          const path = require("node:path");
          const contextRequire = createRequire(path.join(${JSON.stringify(contextPath)}, "package.json"));
          ${barrelChecks}
        `,
        apiDummyEnv
    );
}

console.log(
    "Import safety passed: core packages and 8 API barrel/context combinations loaded without network access."
);
