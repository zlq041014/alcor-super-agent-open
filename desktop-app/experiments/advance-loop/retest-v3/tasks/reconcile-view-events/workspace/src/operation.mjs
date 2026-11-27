export function execute(v) {
  const map=new Map();for(const e of v.events)map.set(e.id,e);return [...map.values()].filter(e=>e.kind!=='delete').map(e=>({id:e.id,title:e.title,rev:e.rev}));
}
