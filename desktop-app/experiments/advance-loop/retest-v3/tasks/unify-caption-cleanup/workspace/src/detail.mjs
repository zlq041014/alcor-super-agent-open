export function detail(value) {
  return (value??'').trim().replace(/\s+/g,' ')||'未命名';
}
