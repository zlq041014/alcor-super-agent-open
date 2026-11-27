import { quantiles } from "./settings.mjs";
export function usageProfile(samples) {
  const values=samples.filter(value=>Number.isFinite(value) && value>=0).sort((a,b)=>a-b);
  const n=values.length;
  const result={count:samples.length,known:n,mean:n ? values.reduce((a,b)=>a+b,0)/n : null};
  for (const [key,fraction] of Object.entries(quantiles))
    result[key]=n ? values[Math.ceil(n*fraction)-1] : null;
  return result;
}
