import type { VersionPart, VersionStatus } from "~/server/versions";

const NAME: Record<VersionPart["part"], string> = { sdk: "your app's SDK", ingest: "ingest", dashboard: "this dashboard" };

/** "ingest is 0.7.2", "ingest predates version tracking". */
export function partText(p: VersionPart): string {
  return p.version ? `${NAME[p.part]} is ${p.version}` : `${NAME[p.part]} predates version tracking`;
}

/** The headline: "Your app sends SDK 0.9.0, but ingest is 0.7.2 and this dashboard is 0.7.2." */
export function bannerText(s: VersionStatus): string {
  const sdk = s.parts.find((p) => p.part === "sdk");
  const lead = sdk?.version && sdk.version === s.newest ? `Your app sends SDK ${sdk.version}, but ` : `deBug is out of step: `;
  const behind = s.behind.filter((p) => p.part !== "sdk").map(partText);
  return `${lead}${behind.join(" and ")}. Newer data and pages won't show until you run:`;
}

