import { defaults } from './defaults.mjs';
export function options(input) { return { ...defaults, ...input }; }
