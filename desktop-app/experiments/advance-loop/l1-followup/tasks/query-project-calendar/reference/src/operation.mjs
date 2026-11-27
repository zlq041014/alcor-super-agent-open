import { dayMs } from "./settings.mjs";
export function nextReminder(after, weekdays, time) {
  if (!weekdays.length || weekdays.some(n=>!Number.isInteger(n) || n<0 || n>6) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    return null;
  const [h,m]=time.split(":").map(Number);
  const start = Math.floor(after/dayMs)*dayMs;
  for (let offset=0;offset<=7;offset++) {
    const day = start+offset*dayMs;
    const at = day+(h*60+m)*60000;
    if (at>after && weekdays.includes(new Date(day).getUTCDay())) return at;
  }
  return null;
}
