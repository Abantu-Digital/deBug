import type { RollupIncrement, RollupRow } from "@debug/schema";

/** Merge increments with the same target so each batch does one write per row. */
export function coalesceRollups(incs: RollupIncrement[]): RollupRow[] {
  const map = new Map<string, RollupRow>();
  for (const i of incs) {
    const id = rollupId(i);
    const row = map.get(id) ?? { app: i.app, day: i.day, dimension: i.dimension, key: i.key, errors: 0, events: 0 };
    if (i.kind === "error") row.errors += i.by;
    else row.events += i.by;
    map.set(id, row);
  }
  return [...map.values()];
}

export const rollupId = (r: { app: string; day: string; dimension: string; key: string }) =>
  `${r.day}__${r.dimension}__${encodeURIComponent(r.key)}`;
