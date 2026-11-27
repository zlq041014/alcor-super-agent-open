import {separator} from "./settings.mjs";
export function filterTags(values) {
  const labels = new Set();
  for (const value of values) if (typeof value === "string" && value.trim()) labels.add(value.trim().toLowerCase());
  return [...labels];
}
export function exportTags(values) {
  const labels = new Set();
  for (const value of values) if (typeof value === "string" && value.trim()) labels.add(value.trim().toLowerCase());
  return [...labels].join(separator);
}
