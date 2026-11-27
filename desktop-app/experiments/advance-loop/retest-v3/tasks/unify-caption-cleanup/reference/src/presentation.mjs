export function format(value) {
  return (value??'').trim().replace(/\s+/g,' ')||'未命名';
}
