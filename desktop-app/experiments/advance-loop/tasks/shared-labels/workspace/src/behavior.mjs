import { listLabel } from './input.mjs';
import { detailLabel } from './output.mjs';

export function calculate(v) {
  return v.map(({place,state}) => place === 'list' ? listLabel(state) : detailLabel(state));
}
