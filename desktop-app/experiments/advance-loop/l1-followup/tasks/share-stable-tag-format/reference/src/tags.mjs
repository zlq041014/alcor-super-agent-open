export function normalizeTags(values) {
  const labels = new Set();
  for (const value of values) if (typeof value === "string" && value.trim()) labels.add(value.trim().toLowerCase());
  return [...labels];
}
