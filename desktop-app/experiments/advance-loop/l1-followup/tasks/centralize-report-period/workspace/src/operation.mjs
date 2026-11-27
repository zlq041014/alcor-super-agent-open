import {unknownPeriod} from "./settings.mjs";
export function weeklyHeading(first, last) {
  const a = String(first ?? "").trim(), b = String(last ?? "").trim();
  const span = /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) ? a === b ? a : a + " 至 " + b : unknownPeriod;
  return "周报 · " + span;
}
export function monthlyHeading(first, last) {
  const a = String(first ?? "").trim(), b = String(last ?? "").trim();
  const span = /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b) ? a === b ? a : a + " 至 " + b : unknownPeriod;
  return "月报 · " + span;
}
