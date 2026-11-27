import { emptyWindow } from "./settings.mjs";
const parse = (raw,fallback) => {
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(value) ? value : fallback;
};
export function pageWindow(pages, start, end) {
  if (!pages) return {...emptyWindow};
  const clamp = n => Math.max(1, Math.min(n,pages));
  const a = clamp(parse(start,1)), b = clamp(parse(end,pages));
  return {first:Math.min(a,b),last:Math.max(a,b),count:Math.abs(a-b)+1};
}
