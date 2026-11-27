export function execute(v) {
  let left=v.items.slice(); const done=new Set(), batches=[];
  while(left.length){const layer=left.filter(x=>(x.dependsOn??[]).every(id=>done.has(id)));if(!layer.length)break; const ids=layer.map(x=>x.id); batches.push(ids);for(const id of ids)done.add(id);left=left.filter(x=>!done.has(x.id));}
  return { batches, blocked:left.map(x=>x.id) };
}
