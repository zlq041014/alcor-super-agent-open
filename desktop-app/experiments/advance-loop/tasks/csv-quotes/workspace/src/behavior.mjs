export function calculate(text) {
  const values = text.split(','); return values.map(x => x.replace(/^"|"$/g, ''));
}
