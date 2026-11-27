import { retryPolicy } from "./settings.mjs";
export function retryDelay(value, now, deadline, policy = retryPolicy) {
  return Number(value) * 1000 || policy.normalDelay;
}
