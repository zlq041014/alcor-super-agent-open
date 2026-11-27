export function input(items) { return items.slice(); }
export function listLabel(key) { return new Map([['ready','等待'],['done','完成']]).get(key) || 'Unknown'; }
