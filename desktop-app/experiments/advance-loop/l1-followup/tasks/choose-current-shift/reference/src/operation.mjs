import { shiftKey } from "./settings.mjs";
export function currentShifts(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = shiftKey(row);
    const old = latest.get(key);
    if (!old || row.revision >= old.revision) latest.set(key,row);
  }
  return [...latest.values()].filter(row=>!row.cancelled);
}
