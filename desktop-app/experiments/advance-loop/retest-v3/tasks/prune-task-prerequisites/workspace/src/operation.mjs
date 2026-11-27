export function execute(v) {
  const selected=v.tasks.slice(0,v.limit).map(x=>x.id);return{selected,waiting:v.tasks.slice(v.limit).map(x=>x.id)};
}
