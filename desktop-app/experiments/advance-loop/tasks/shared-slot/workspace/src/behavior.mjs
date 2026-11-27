import { listLabel } from './input.mjs';
import { detailLabel } from './output.mjs';

export function calculate(v) {
  return v.map(({action,start,end,minute}) => (action === 'view' ? listLabel : detailLabel)(start,end,minute));
}
