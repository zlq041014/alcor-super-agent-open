import { defaults } from './defaults.mjs';
import { input } from './input.mjs';
import { output } from './output.mjs';
import { calculate } from './behavior.mjs';

export function run(value = defaults) {
  return output(calculate(input(value)));
}
