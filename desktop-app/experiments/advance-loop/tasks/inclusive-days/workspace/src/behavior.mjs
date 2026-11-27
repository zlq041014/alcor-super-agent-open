export function calculate(v) {
  return Math.max(0, Number(v.end.slice(-2)) - Number(v.start.slice(-2)));
}
