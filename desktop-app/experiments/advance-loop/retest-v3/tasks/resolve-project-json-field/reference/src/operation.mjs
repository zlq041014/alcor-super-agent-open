export function execute(v) {
  if(v.pointer==='' )return {found:true,value:v.data}; if(!v.pointer.startsWith('/'))return {found:false};let current=v.data;
  for(const raw of v.pointer.slice(1).split('/')){if(/~(?![01])/.test(raw))return {found:false};const key=raw.replace(/~1/g,'/').replace(/~0/g,'~');if(!current||typeof current!=='object'||(Array.isArray(current)&&!/^(?:0|[1-9]\d*)$/.test(key))||!Object.hasOwn(current,key))return {found:false};current=current[key];}return {found:true,value:current};
}
