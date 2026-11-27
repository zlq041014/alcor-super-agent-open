export function calculate(text) {
  const fields = []; let value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && quoted && text[i+1] === '"') { value += '"'; i++; }
    else if (ch === '"' && (quoted || value === '')) quoted = !quoted;
    else if (ch === ',' && !quoted) { fields.push(value); value = ''; }
    else value += ch;
  }
  return [...fields, value];
}
