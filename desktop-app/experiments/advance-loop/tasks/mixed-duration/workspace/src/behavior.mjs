export function calculate(text) {
  return /^\d+$/.test(text) ? Number(text)*60 : null;
}
