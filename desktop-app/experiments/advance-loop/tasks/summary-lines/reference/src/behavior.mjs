export function calculate(v) {
  const prefix = v.prefix ?? '';
  return v.text.replace(/(^|\r?\n)(?=[\s\S])/g, '$1' + prefix.replaceAll('$','$$$$'));
}
