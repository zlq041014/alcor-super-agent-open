import { execute } from './operation.mjs';
import { options } from './options.mjs';
import { result } from './result.mjs';
export function run(input = {}) { return result(execute(options(input))); }
