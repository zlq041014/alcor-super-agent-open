export function calculate(v) {
  const groups = {};
  for (const item of v) (groups[item.tag] ||= []).push(item.title);
  return Object.entries(groups);
}
