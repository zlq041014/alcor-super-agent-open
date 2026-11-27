export function execute(v) {
  return { batches:[v.items.map(x=>x.id)], blocked:[] };
}
