import { timeRange } from "./settings.mjs";
export function reserve(windows, [min,max] = timeRange) {
  const clipped = windows.map(([a,b]) => [Math.max(a,min),Math.min(b,max)])
    .filter(([a,b]) => b>a).sort((a,b) => a[0]-b[0]);
  const combined = [];
  for (const [a,b] of clipped) {
    const previous = combined.at(-1);
    if (previous && a <= previous[1]) previous[1] = Math.max(previous[1],b);
    else combined.push([a,b]);
  }
  return {windows:combined,minutes:combined.reduce((n,[a,b]) => n+b-a,0)};
}
