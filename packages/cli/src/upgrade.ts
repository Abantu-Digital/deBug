import { readFileSync } from "node:fs";
import { join } from "node:path";
import FIRESTORE_INDEXES from "../../adapters/firestore.indexes.json" with { type: "json" };
import { VERSION } from "./dashboard";
import { hostDashboard } from "./hosting";
import { upgradeAwsIngest } from "./providers/aws";
import { FUNCTION_NAME, upgradeFirebaseIngest } from "./providers/firebase";
import { compareVersions, notesBetween, parseVersion, RELEASES, type ReleaseNotes } from "./releases";
import { cmdFor, environment, paths, readConfig, writeConfig, type DebugkitConfig } from "./state";
import { bail, bold, code, dim, fail, p, pc, yes } from "./ui";

/** The deBug versions deployed for this setup. Undefined when the setup doesn't say. */
export interface Deployed {
  ingest?: string;
  dashboard?: string;
}

const readJson = (file: string): Record<string, any> | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The version of a package in a Firebase source folder: what npm installed for the last deploy,
 * or the range its package.json asked for ("^0.7.0" reads as 0.7.0).
 */
function installedVersion(folder: string, pkg: string): string | undefined {
  const installed = readJson(join(folder, "node_modules", ...pkg.split("/"), "package.json"))?.version;
  const wanted = readJson(join(folder, "package.json"))?.dependencies?.[pkg];
  const v = parseVersion(installed) ?? parseVersion(wanted);
  return v?.join(".");
}

/**
 * What's deployed: saved in the config by CLIs that have `upgrade`. Older Firebase setups are read from the source
 * deBug wrote in .debugkit/firebase; older AWS setups don't record it.
 */
export function deployedVersions(cwd: string, cfg: DebugkitConfig): Deployed {
  const dir = paths(cwd).firebase;
  const firebase = cfg.provider === "firebase";
  return {
    ingest: cfg.version ?? (firebase ? installedVersion(join(dir, "functions"), "@debugkit/ingest") : undefined),
    dashboard: cfg.hosted ? (cfg.hosted.version ?? (firebase ? installedVersion(join(dir, "dashboard"), "@debugkit/dashboard") : undefined)) : undefined,
  };
}

export interface UpgradePlan {
  /** One line per part, "what: from → to". */
  lines: string[];
  /** Set when something deployed is newer than this CLI (upgrading would take it back): what to run instead. */
  cliBehind?: string;
  /** Every part is known to be at this CLI's version already. */
  upToDate: boolean;
  /** One line per version between the oldest part deployed and this CLI. Empty when that isn't known. */
  notes: string[];
}

/** "0.7.0 → ", the start of a "from → to" line. */
const fromVersion = (v: string | undefined) => (v ? `${v} → ` : `${dim("version not recorded")} → `);

export function upgradePlan(cfg: DebugkitConfig, deployed: Deployed, cli = VERSION, releases: ReleaseNotes = RELEASES): UpgradePlan {
  const ahead = [deployed.ingest, deployed.dashboard].filter((v) => v && compareVersions(v, cli) > 0);
  const newest = ahead.sort((a, b) => compareVersions(b, a))[0];
  const cliBehind = newest
    ? `This setup runs deBug ${newest}, newer than this CLI (${cli}). Run the newer CLI instead: ${code(`npx @debugkit/cli@${newest} upgrade${environment.get() ? ` --env ${environment.get()}` : ""}`)}.`
    : undefined;

  const ingest =
    cfg.provider === "firebase"
      ? `Cloud Function ${FUNCTION_NAME} in ${cfg.firebase?.region} (${cfg.firebase?.projectId})`
      : `Lambda ${cfg.aws?.functionName} in ${cfg.aws?.region}`;
  const lines = [
    `${bold("Ingest")}: ${fromVersion(deployed.ingest)}${cli} · ${ingest}, same URL and keys`,
    cfg.provider === "firebase"
      ? `${bold("Firestore indexes")}: deBug's ${FIRESTORE_INDEXES.indexes.length}, added where missing (your own indexes are left alone)`
      : `${bold("Indexes")}: ${dim("none needed (DynamoDB)")}`,
    cfg.hosted
      ? `${bold("Hosted dashboard")}: ${fromVersion(deployed.dashboard)}${cli} · ${cfg.hosted.url}, same login`
      : `${bold("Hosted dashboard")}: ${dim(`not set up (host it with ${cmdFor("deploy-dashboard")})`)}`,
  ];
  const parts = [deployed.ingest, ...(cfg.hosted ? [deployed.dashboard] : [])];
  const upToDate = parts.every((v) => v !== undefined && compareVersions(v, cli) === 0);
  // From the oldest part, so every change that part hasn't had yet is listed.
  const oldest = parts.every(Boolean) ? (parts as string[]).sort(compareVersions)[0] : undefined;
  return { lines, cliBehind, upToDate, notes: oldest ? notesBetween(releases, oldest, cli) : [] };
}

/** npx debugkit upgrade: bring ingest, the indexes and the hosted dashboard to this CLI's version. */
export async function upgrade(cwd: string, cfg: DebugkitConfig, opts: { dryRun: boolean }) {
  const env = environment.get() ? ` (${environment.get()})` : "";
  p.intro(`${pc.bgRed(pc.white(" deBug "))} upgrade to ${VERSION}${env}`);
  if (cfg.provider === "local") {
    p.outro(`This setup runs on this machine, so nothing is deployed. ${code(cmdFor("dashboard"))} already runs dashboard ${VERSION}.`);
    return;
  }
  const plan = upgradePlan(cfg, deployedVersions(cwd, cfg));
  if (plan.cliBehind) fail(plan.cliBehind);
  p.note(plan.lines.join("\n"), opts.dryRun ? "Would deploy" : "About to deploy");
  const whatsNew = () => {
    if (plan.notes.length) p.note(plan.notes.join("\n"), "What's new");
  };
  if (opts.dryRun) {
    whatsNew();
    p.outro(`Dry run: nothing was deployed. Run ${code(cmdFor("upgrade"))} to deploy it.`);
    return;
  }
  if (plan.upToDate && !(await yes(`Everything is already at ${VERSION}. Deploy it again anyway?`, false))) {
    p.outro("Nothing changed.");
    return;
  }
  if (!plan.upToDate && !(await yes(`Upgrade deBug${env} to ${VERSION}?`))) bail("Nothing was deployed.");

  // Ingest first: the new dashboard reads fields only the new ingest writes.
  let indexes = false;
  if (cfg.provider === "firebase") indexes = (await upgradeFirebaseIngest(cwd, cfg)).indexes;
  else await upgradeAwsIngest(cfg);
  p.log.success(`Ingest runs deBug ${VERSION} at ${code(cfg.endpoint)}`);
  // The version covers the indexes too: if they didn't deploy, keep the old one so the next run tries again.
  const complete = cfg.provider !== "firebase" || indexes;
  if (complete) writeConfig(cwd, { ...cfg, version: VERSION });

  let url = cfg.hosted?.url;
  if (cfg.hosted) {
    // Hosting stops the command on a failure, with what to fix; ingest is already upgraded by then.
    const out = await hostDashboard(cwd, readConfig(cwd) ?? cfg, { confirmed: true, indexesDeployed: indexes });
    url = out?.url ?? url;
  }
  whatsNew();

  p.outro(
    [
      `deBug${env} is at ${VERSION}.`,
      cfg.provider === "firebase" && !indexes ? `The Firestore indexes didn't deploy: run ${code(cmdFor("upgrade"))} again to add them.` : "",
      url ? `Dashboard: ${code(url)}` : `Open the dashboard with ${code(cmdFor("dashboard"))}.`,
    ]
      .filter(Boolean)
      .join("\n   "),
  );
}
