import { shiftKey } from "./settings.mjs";
export function currentShifts(rows) {
  return [...new Map(rows.filter(row=>!row.cancelled).map(row=>[shiftKey(row),row])).values()];
}
