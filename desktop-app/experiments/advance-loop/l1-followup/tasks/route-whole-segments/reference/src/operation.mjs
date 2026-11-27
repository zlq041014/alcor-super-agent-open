import { routes } from "./settings.mjs";
const noTail = path => path.replace(/\/+$/, "") || "/";
export function helpSection(path, entries = routes) {
  path = noTail(path.split(/[?#]/)[0]);
  let picked = null, best = -1;
  for (const [input, label] of entries) {
    const prefix = noTail(input);
    if (prefix.length > best && (path === prefix || path.startsWith(prefix === "/" ? "/" : prefix+"/"))) {
      best = prefix.length;
      picked = label;
    }
  }
  return picked;
}
