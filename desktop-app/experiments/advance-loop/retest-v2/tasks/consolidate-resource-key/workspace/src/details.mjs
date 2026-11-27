export function details(value) {
  return value.trim().toLowerCase().split(/\s+/).join('_');
}
