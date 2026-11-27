export function usageProfile(samples) {
  const values=samples.filter(value=>typeof value==="number" && Number.isFinite(value) && value>=0);
  return { count:samples.length,known:values.length,mean:values.length ? values.reduce((a,b)=>a+b,0)/values.length : null };
}
