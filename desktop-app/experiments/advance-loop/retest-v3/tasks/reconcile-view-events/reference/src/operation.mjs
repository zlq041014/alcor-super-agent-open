export function execute(v) {
  const map=new Map();
  for(const e of v.events){const p=map.get(e.id);if(!p||e.rev>p.rev||(e.rev===p.rev&&e.seq>=p.seq))map.set(e.id,e);}
  return [...map.values()].filter(e=>e.kind!=='delete').map(e=>({id:e.id,title:e.title,rev:e.rev}));

}
