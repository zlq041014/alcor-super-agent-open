export function list(value) {
  const seconds=Math.floor(Math.max(0,value)/1000);return seconds<60?seconds+' 秒':Math.floor(seconds/60)+' 分 '+(seconds%60)+' 秒';
}
