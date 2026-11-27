export function execute(v) {
  const passed=v.statuses.filter(x=>x==='passed').length;const failed=v.statuses.filter(x=>x==='failed').length;const skipped=v.statuses.filter(x=>x==='skipped').length;return {total:passed+failed,passed,failed,skipped};
}
