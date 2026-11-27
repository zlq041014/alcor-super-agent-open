import { retryDelay } from "./index.mjs";

export function preview() {
  return JSON.stringify(retryDelay(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
