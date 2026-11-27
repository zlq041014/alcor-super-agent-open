export function history(value) {
  return (value??'').trim().replace(/\s+/g,' ')||'未命名';
}
