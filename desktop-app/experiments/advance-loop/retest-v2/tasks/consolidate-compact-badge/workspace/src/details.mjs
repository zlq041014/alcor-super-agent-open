export function details(value) {
  return value<=0?'':value>99?'99+':String(value);
}
