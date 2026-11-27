import { routes } from "./settings.mjs";
export function helpSection(path, entries = routes) {
  return entries.find(([prefix]) => path.startsWith(prefix))?.[1] ?? null;
}
