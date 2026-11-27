import { reserve } from "./index.mjs";

export function preview() {
  return JSON.stringify(reserve(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
