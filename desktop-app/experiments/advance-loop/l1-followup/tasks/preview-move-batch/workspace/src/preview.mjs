import { moveSelection } from "./index.mjs";

export function preview() {
  return JSON.stringify(moveSelection(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
