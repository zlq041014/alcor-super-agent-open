export function execute(v) {
  return v.chunks.join('').split('\n\n').map(part=>({type:'message',id:'',data:part.replace(/^data: /,'')})).filter(x=>x.data);
}
