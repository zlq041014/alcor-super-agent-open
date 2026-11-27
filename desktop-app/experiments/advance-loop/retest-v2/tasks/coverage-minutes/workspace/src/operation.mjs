export function execute(v) {
  return v.periods.reduce((n,[a,b])=>n+Math.max(0,b-a),0);
}
