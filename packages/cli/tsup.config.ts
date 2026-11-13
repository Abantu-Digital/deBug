import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig([
  {
    // The CLI itself. The SDK is bundled in, so `npx debugkit test` can send events without installing anything.
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "node20",
    clean: true,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: ["@debugkit/sdk", "@debugkit/schema"],
    external: [/^@aws-sdk\//],
    splitting: false,
    // The dashboard is released in lockstep with the CLI (one changeset group), so run the same version.
    define: { __DEBUGKIT_VERSION__: JSON.stringify(version) },
  },
  {
    // The Lambda function the AWS setup deploys: ingest + DynamoDB adapter in one file.
    // The AWS SDK is left out because the Node.js Lambda runtime provides it.
    entry: { "lambda/index": "assets/lambda.ts" },
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node22",
    noExternal: [/^(?!@aws-sdk\/).*/],
    splitting: false,
    minify: true,
    esbuildOptions(o) {
      o.external = ["@aws-sdk/*"];
    },
  },
]);
