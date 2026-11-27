export function execute(v) {
  let t=Date.parse(v.start), left=v.minutes;const holidays=new Set(v.holidays), minute=60000;
  for(;;){const d=new Date(t), date=d.toISOString().slice(0,10), midnight=Date.parse(date+'T00:00:00Z'); if(d.getUTCDay()!==0&&d.getUTCDay()!==6&&!holidays.has(date)){for(const [h,k] of [[9,12],[13,18]]){const a=midnight+h*60*minute,b=midnight+k*60*minute;if(t>=b)continue;t=Math.max(t,a);const available=(b-t)/minute;if(left<=available)return new Date(t+left*minute).toISOString();left-=available;}}t=midnight+1440*minute;}

}
