// Build every publishable package and pack it into .packs/ exactly as npm would receive it.
// The example apps install from these tarballs, so they test what customers actually get.
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";

const out = new URL("../.packs/", import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const dir of ["schema", "sdk", "ingest", "adapters"]) {
  execSync(`pnpm pack --pack-destination ${out}`, { cwd: new URL(`../packages/${dir}/`, import.meta.url).pathname, stdio: "inherit" });
}
// Stable names (no version) so example package.json files don't change on every bump.
for (const f of readdirSync(out)) renameSync(out + f, out + f.replace(/-\d+\.\d+\.\d+.*\.tgz$/, ".tgz"));
console.log("packed:", readdirSync(out).join(", "));
