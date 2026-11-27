import { options } from './options.mjs';
import { execute } from './operation.mjs';
import { immutable } from './result.mjs';
export function run(input = {}) { return immutable(execute(options(input))); }
