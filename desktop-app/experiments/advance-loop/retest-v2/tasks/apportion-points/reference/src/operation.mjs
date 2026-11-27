export function execute(v) {
  const sum=v.weights.reduce((a,b)=>a+b,0);
  if(!sum) return v.weights.map(()=>0);
  const exact=v.weights.map(w=>v.total*w/sum), out=exact.map(Math.floor);
  const order=out.map((whole,i)=>[i,exact[i]-whole]).sort((a,b)=>b[1]-a[1]||a[0]-b[0]);
  const left=v.total-out.reduce((a,b)=>a+b,0); for(let i=0;i<left;i++) out[order[i][0]]++;
  return out;
}
