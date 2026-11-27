export function format(value) {
  const labels={waiting:'等待确认',approved:'已批准',denied:'已拒绝'};return Object.hasOwn(labels,value)?labels[value]:'未知状态';
}
