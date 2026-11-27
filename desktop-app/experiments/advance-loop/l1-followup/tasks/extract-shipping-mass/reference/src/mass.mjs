import { unitScale } from "./settings.mjs";

export function toGrams(value, unit) {
  return Number.isFinite(value) && value>=0 && Object.hasOwn(unitScale,unit) ? Math.round(value*unitScale[unit]) : null;
}
