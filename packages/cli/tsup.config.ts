import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "tsup";
import { releaseNotes } from "./src/releases";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
// Every package's changelog: they release together, and a change may be listed under any of them.
const changelogs = ["cli", "sdk", "ingest", "adapters", "schema"]
  .map((name) => new URL(`../${name}/CHANGELOG.md`, import.meta.url))
  .concat(new URL("../../apps/dashboard/CHANGELOG.md", import.meta.url))
  .filter((u) => existsSync(u))
  .map((u) => readFileSync(u, "utf8"));

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
    // `npx debugkit upgrade` lists what changed in each version it skips, without going online.
    define: { __DEBUGKIT_VERSION__: JSON.stringify(version), __DEBUGKIT_RELEASES__: JSON.stringify(releaseNotes(changelogs)) },
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
