export function calculate(v) {
  const segments = Array.from(new Intl.Segmenter(undefined, {granularity:'grapheme'}).segment(v.text), x => x.segment);
  if (v.limit <= 0) return '';
  return segments.length <= v.limit ? v.text : segments.slice(0,v.limit-1).join('') + '…';
}
