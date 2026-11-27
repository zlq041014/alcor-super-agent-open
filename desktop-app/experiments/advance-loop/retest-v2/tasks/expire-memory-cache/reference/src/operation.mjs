export function execute(v) {
  const items=v.entries.filter(r=>r.expiresAt==null||r.expiresAt>v.now); return {items,expired:v.entries.length-items.length};
}
