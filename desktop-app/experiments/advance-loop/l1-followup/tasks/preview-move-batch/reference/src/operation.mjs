import { endOfList } from "./settings.mjs";
export function moveSelection(ids, selected, before = endOfList) {
  const matches = new Set(selected);
  if (ids.includes(before) && matches.has(before)) return [...ids];
  const moving=ids.filter(id=>matches.has(id));
  const rest=ids.filter(id=>!matches.has(id));
  const index=rest.indexOf(before);
  if (index===-1) return [...rest,...moving];
  return [...rest.slice(0,index),...moving,...rest.slice(index)];
}
