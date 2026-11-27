export function calculate(v) {
  const groups = new Map();
  for (const entry of v) {
    const name = String(entry.tag);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry.title);
  }
  return [...groups];
}
