export function output(value) { return value; }
export function detailLabel(key) { return new Map([['ready','等待'],['done','完成']]).get(key) || 'Unknown'; }
