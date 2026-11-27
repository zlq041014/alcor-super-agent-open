export function calculate(v) {
  const [a, b] = v.first, [c, d] = v.second;
  return Math.max(a, c) < Math.min(b, d);
}
