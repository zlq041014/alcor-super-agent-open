export function execute(v) {
  const map=new Map(v.samples.map(s=>[s.at,s.value]));const points=[...map].sort((a,b)=>a[0]-b[0]);if(!points.length)return null;
  if(v.at<=points[0][0])return points[0][1];if(v.at>=points.at(-1)[0])return points.at(-1)[1];
  const i=points.findIndex(p=>p[0]>=v.at),[l,x]=points[i-1],[r,y]=points[i];return x+(y-x)*(v.at-l)/(r-l);
}
