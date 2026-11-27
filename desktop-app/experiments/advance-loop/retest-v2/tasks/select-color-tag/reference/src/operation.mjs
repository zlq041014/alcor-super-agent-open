export function execute(v) {
  const label=v.label.toLowerCase(); const entry=Object.entries(v.colors).find(([key])=>key.toLowerCase()===label); return entry?.[1] ?? v.colors.default ?? '';
}
