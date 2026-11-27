export function calculate(v) {
  return { feed: v.filter(x=>!x.archived).map(x=>x.title), history: v.map(x=>x.title) };
}
