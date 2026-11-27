export function execute(v) {
  const seen=new Map(); for(const e of v.entries){const old=seen.get(e.id);if(!old||e.at>=old.at)seen.set(e.id,e);} return [...seen.values()];
}
