export function calculate(v) {
  return v.reduce((total, x) => total + Math.round(Number(x) * 100), 0);
}
