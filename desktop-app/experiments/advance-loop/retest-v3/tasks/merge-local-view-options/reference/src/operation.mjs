export function execute(v) {
  const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);const clone=x=>Array.isArray(x)?x.map(clone):plain(x)?Object.fromEntries(Object.entries(x).map(([k,val])=>[k,clone(val)])):x;
  const merge=(a,b)=>{if(b===undefined)return clone(a);if(!plain(b))return clone(b);const entries=new Map(plain(a)?Object.entries(a):[]);for(const [k,x] of Object.entries(b)){if(x!==undefined)entries.set(k,merge(entries.get(k),x));}return Object.fromEntries([...entries].map(([k,val])=>[k,clone(val)]));};
  return merge(v.defaults,v.override);
}
