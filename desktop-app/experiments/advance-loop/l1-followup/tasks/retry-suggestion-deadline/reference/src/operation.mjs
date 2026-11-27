import { retryPolicy } from "./settings.mjs";
export function retryDelay(value, now, deadline, policy = retryPolicy) {
  let delay = policy.normalDelay;
  const raw = typeof value === "string" ? value.trim() : "";
  if (/^\d+$/.test(raw)) delay = Number(raw) * 1000;
  else if (/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    const stamp = Date.parse(raw);
    if (!Number.isNaN(stamp) && new Date(stamp).toUTCString() === raw)
      delay = Math.max(0, stamp - now);
  }
  return Math.max(0, Math.min(delay, policy.maxDelay, deadline - now));
}
