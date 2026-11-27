export function execute(v) {
  const sorted=v.periods.filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]); let end=-Infinity,total=0;
  for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
  return total;
}
