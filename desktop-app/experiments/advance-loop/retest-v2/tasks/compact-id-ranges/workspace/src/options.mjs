import { defaultValues } from './defaults.mjs';
export function options(input) { return { ...defaultValues, ...input }; }
