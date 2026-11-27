import {unknownPeriod} from "./settings.mjs";
export function formatPeriod(first, last) {
  const a = String(first ?? "").trim(), b = String(last ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) ? a === b ? a : a + " 至 " + b : unknownPeriod;
}
