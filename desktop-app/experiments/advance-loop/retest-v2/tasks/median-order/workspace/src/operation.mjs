export function execute(v) {
  const a=v.values.sort(); return a[Math.floor(a.length/2)] ?? null;
}
