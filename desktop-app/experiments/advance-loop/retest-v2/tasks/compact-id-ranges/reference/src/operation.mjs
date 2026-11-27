export function execute(v) {
  const ids=[...new Set(v.ids)].sort((a,b)=>a-b), groups=[];
  for(let i=0;i<ids.length;i++){const a=ids[i]; while(ids[i+1]===ids[i]+1)i++; groups.push(a===ids[i]?String(a):a+'..'+ids[i]);}
  return groups.join(',');
}
