export function result(value) { return typeof value === 'object' && value !== null ? Object.freeze(value) : value; }
