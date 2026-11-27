import { defaultChannel } from "./settings.mjs";
export function reminderDigest(rows, options = {}) {
  const groups = new Map();
  for (const row of rows) {
    if (options.onlyUnread === true && row.unread !== true) continue;
    const channel = row.channel ?? defaultChannel;
    const prior = groups.get(channel);
    groups.set(channel,{channel,count:(prior?.count??0)+1,newest:Math.max(prior?.newest??-Infinity,row.at)});
  }
  return [...groups.values()].sort((a,b)=>b.newest-a.newest || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
}
