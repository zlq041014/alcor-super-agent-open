export function calendar(value) {
  return value.trim().toLowerCase().split(/\s+/).join('_');
}
