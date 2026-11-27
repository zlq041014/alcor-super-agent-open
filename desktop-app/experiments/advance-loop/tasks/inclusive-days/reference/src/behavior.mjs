export function calculate(v) {
  const midnight = (date) => Date.parse(date.slice(0, 10) + 'T00:00:00Z');
  return Math.max(0, (midnight(v.end) - midnight(v.start)) / 86400000 + 1);
}
