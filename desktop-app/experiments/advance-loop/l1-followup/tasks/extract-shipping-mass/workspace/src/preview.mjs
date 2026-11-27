import { itemLabel } from "./index.mjs";

export function preview() {
  return JSON.stringify(itemLabel(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
