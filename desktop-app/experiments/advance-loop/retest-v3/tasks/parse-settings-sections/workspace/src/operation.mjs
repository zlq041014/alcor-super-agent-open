export function execute(v) {
  const out={'':{}};let section='';for(const raw of v.source.split(/\r?\n/)){const line=raw.split('#')[0].trim(); if(line.startsWith('[')){section=line.slice(1,-1);out[section]={};}else if(line.includes('=')){const [key,value]=line.split('=');out[section][key.trim()]=value.trim().replace(/^"|"$/g,'');}}return out;
}
