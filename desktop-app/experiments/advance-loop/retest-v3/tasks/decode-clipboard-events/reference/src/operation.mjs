export function execute(v) {
  let id='',kind='',data=[];const out=[]; const flush=()=>{ if(data.length)out.push({type:kind||'message',id,data:data.join('\n')});kind='';data=[]; };
  for(const line of v.chunks.join('').replace(/^\uFEFF/,'').split(/\r\n|[\r\n]/)){if(!line){flush();continue;} if(line[0]===':')continue;let i=line.indexOf(':');const name=i<0?line:line.slice(0,i),val=i<0?'':line.slice(i+1).replace(/^ /,'');if(name==='data')data.push(val);else if(name==='event')kind=val;else if(name==='id'&&!val.includes('\0'))id=val;}flush();return out;
}
