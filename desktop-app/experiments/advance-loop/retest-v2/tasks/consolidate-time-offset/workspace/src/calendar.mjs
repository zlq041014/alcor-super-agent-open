export function calendar(value) {
  const hours=Math.floor(Math.abs(value)/60).toString().padStart(2,'0'); const mins=(Math.abs(value)%60).toString().padStart(2,'0'); return 'UTC'+(value<0?'-':'+')+hours+':'+mins;
}
