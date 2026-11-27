export function execute(v) {
  const [y,m,d]=v.start.split('-').map(Number), result=[];let offset=0;
  if(v.after){const [yy,mm]=v.after.split('-').map(Number);offset=Math.max(0,(yy-y)*12+mm-m);}
  for(let i=offset;result.length<v.limit;i++){const end=new Date(Date.UTC(y,m+i,0)).getUTCDate();const day=new Date(Date.UTC(y,m+i-1,Math.min(d,end))).toISOString().slice(0,10);if(!v.after||day>v.after)result.push(day);}
  return result;
}
