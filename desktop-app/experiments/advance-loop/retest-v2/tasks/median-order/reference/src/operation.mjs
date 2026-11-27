export function execute(v) {
  const a=[...v.values].sort((a,b)=>a-b); const i=Math.floor(a.length/2); return a.length===0?null:a.length%2?a[i]:(a[i-1]+a[i])/2;
}
