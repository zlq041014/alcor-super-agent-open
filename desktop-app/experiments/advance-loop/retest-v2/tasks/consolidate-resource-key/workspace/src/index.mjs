import { options } from './options.mjs';
import { execute } from './screen.mjs';
import { immutable } from './result.mjs';
export function run(input = {}) { return immutable(execute(options(input))); }
