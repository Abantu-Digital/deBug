#!/usr/bin/env node
// `npx debugkit <command>` in an app that has @debugkit/sdk installed. Runs the setup CLI,
// @debugkit/cli, at the same version as this SDK. Nothing here is part of the SDK's runtime code.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
// For developing deBug itself: run a local build of the CLI instead of the published one.
const local = process.env.DEBUGKIT_CLI_PATH;
const [cmd, argv] = local ? [process.execPath, [local, ...args]] : ["npx", ["-y", `@debugkit/cli@${version}`, ...args]];

// npx is npx.cmd on Windows, which Node only runs through a shell.
const child = spawn(cmd, argv, { stdio: "inherit", shell: process.platform === "win32" && !local });
child.on("error", (err) => {
  console.error(`Couldn't start the deBug CLI: ${err.message}\nTry: npx @debugkit/cli@${version} ${args.join(" ")}`);
  process.exit(1);
});
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
