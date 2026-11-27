import { toGrams } from "./mass.mjs";

export function itemLabel(value, unit) {
  const grams = toGrams(value,unit);
  return grams === null ? "重量未知" : "重量 " + grams + " g";
}
export function manifestRow(value, unit) {
  const grams = toGrams(value,unit);
  return { grams, weighed: grams !== null };
}
