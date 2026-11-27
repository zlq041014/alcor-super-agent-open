export function execute(v) {
  return v.text.replace(/\[\[([A-Za-z0-9-]+)\]\]/g,'{$1}');
}
