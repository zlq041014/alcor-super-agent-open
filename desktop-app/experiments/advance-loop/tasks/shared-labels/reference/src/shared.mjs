export function label(key) { return new Map([['ready','等待'],['done','完成']]).get(key) || 'Unknown'; }
