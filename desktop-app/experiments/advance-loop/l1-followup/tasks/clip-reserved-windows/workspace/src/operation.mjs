import { timeRange } from "./settings.mjs";
export function reserve(windows, range = timeRange) {
  return { windows, minutes: windows.reduce((sum, [a,b]) => sum + (b-a), 0) };
}
