export function calculate(text) {
  if (/^\s*\d+\s*$/.test(text)) return Number(text) * 60;
  let left = text.trim(), total = 0;
  if (!left) return null;
  while (left.length) {
    const m = /^(\d+)\s*([hms])\s*/i.exec(left);
    if (!m) return null;
    total += Number(m[1]) * ({ h:3600,m:60,s:1 })[m[2].toLowerCase()];
    left = left.slice(m[0].length);
  }
  return total;
}
