import {defaultPageSize,maxPageSize} from "./settings.mjs";
export function pageProjects(ids, size=defaultPageSize, from) {
  const limit=Number.isInteger(size) && size>0 ? Math.min(size,maxPageSize) : defaultPageSize;
  const start=from===undefined ? 0 : ids.indexOf(from)+1;
  const items=ids.slice(start,start+limit);
  return {items,cursor:start+items.length<ids.length ? items.at(-1) : null};
}
