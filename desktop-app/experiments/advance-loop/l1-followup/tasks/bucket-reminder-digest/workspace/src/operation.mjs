import { defaultChannel } from "./settings.mjs";
export function reminderDigest(rows) {
  const groups = new Map();
  for (const row of rows) {
    const channel = row.channel ?? defaultChannel;
    const prior = groups.get(channel);
    groups.set(channel,{channel,count:(prior?.count??0)+1,newest:Math.max(prior?.newest??-Infinity,row.at)});
  }
  return [...groups.values()];
}
