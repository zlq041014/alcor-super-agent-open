import { listLabel } from './input.mjs';
import { detailLabel } from './output.mjs';

export function calculate(v) {
  return v.map(({style,n}) => style === 'short' ? listLabel(n) : detailLabel(n));
}
