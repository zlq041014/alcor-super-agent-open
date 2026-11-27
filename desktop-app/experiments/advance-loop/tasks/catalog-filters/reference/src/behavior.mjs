export function calculate(v) {
  const query = v.query?.trim().toLocaleLowerCase() ?? '';
  return v.items.filter(({title,score}) => title.toLocaleLowerCase().includes(query) &&
    (v.min == null || score >= v.min) && (v.max == null || score <= v.max));
}
