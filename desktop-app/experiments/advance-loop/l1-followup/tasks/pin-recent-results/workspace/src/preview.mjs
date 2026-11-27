import { orderedResults } from "./index.mjs";

export function preview() {
  return JSON.stringify(orderedResults(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
