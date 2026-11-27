export function immutable(value) { return value && typeof value === 'object' ? Object.freeze(value) : value; }
