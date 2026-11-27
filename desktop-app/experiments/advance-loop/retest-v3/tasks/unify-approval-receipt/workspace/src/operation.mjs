import { list } from './list.mjs';
import { detail } from './detail.mjs';
import { history } from './history.mjs';
export function execute({surface,value}) { return ({list,detail,history})[surface](value); }
