export function calculate(v) {
  const start = v.after == null ? 0 : v.items.findIndex((item) => item.id === v.after) + 1;
  if ((v.after != null && start === 0) || !Number.isInteger(v.limit ?? v.items.length) || v.limit === 0) return { items: [], next: null };
  const page = v.items.slice(start, start + Math.max(0, v.limit ?? v.items.length));
  return { items: page, next: page.length && start + page.length < v.items.length ? page.at(-1).id : null };
}
