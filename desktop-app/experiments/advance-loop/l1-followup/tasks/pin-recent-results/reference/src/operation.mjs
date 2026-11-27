import { noPins } from "./settings.mjs";
export function orderedResults(entries, pinned = noPins, limit = entries.length) {
  const found=new Map(entries.map(row=>[row.id,row]));
  const seen=new Set();
  const first=[];
  for (const id of pinned) {
    if (!seen.has(id) && found.has(id)) {
      seen.add(id);
      first.push(found.get(id));
    }
  }
  const rest=entries.filter(row=>!seen.has(row.id)).sort((a,b)=>b.at-a.at);
  return [...first,...rest].slice(0,Math.max(0,limit));
}
