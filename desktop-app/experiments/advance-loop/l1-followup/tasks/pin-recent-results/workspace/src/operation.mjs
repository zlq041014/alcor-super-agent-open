export function orderedResults(entries, pinned, limit = entries.length) {
  return entries.slice().sort((a,b)=>b.at-a.at).slice(0,limit);
}
