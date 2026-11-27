export function execute(v) {
  return v.weights.map(w=>Math.round(v.total*w/v.weights.reduce((a,b)=>a+b,0)));
}
