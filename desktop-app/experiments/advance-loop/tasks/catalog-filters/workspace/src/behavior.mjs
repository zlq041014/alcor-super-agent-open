export function calculate(v) {
  return v.items.filter(x => !v.query || x.title.includes(v.query));
}
