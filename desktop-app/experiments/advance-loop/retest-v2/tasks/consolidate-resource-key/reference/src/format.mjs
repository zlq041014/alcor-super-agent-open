export function format(value) {
  return value.trim().toLowerCase().split(/\s+/).join('_');
}
