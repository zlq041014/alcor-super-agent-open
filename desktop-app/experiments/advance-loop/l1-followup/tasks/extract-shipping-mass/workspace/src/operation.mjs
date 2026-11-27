import { unitScale } from "./settings.mjs";

export function itemLabel(value, unit) {
  const grams = Number.isFinite(value) && value>=0 && Object.hasOwn(unitScale,unit) ? Math.round(value*unitScale[unit]) : null;
  return grams === null ? "重量未知" : "重量 " + grams + " g";
}
export function manifestRow(value, unit) {
  const grams = Number.isFinite(value) && value>=0 && Object.hasOwn(unitScale,unit) ? Math.round(value*unitScale[unit]) : null;
  return { grams, weighed: grams !== null };
}
