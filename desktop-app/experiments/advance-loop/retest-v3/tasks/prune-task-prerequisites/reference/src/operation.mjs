export function execute(v) {
  const ordered=v.tasks.slice().sort((a,b)=>(b.priority??0)-(a.priority??0)), occupied=new Set(v.busy), done=new Set(v.done), selected=[];
  for(const t of ordered){if(selected.length>=v.limit)break;if(occupied.has(t.project)||!(t.dependencies??[]).every(id=>done.has(id)))continue; selected.push(t.id);occupied.add(t.project);}const chosen=new Set(selected);
  return {selected,waiting:v.tasks.filter(t=>!chosen.has(t.id)).map(t=>t.id)};
}
