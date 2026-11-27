import { stopSummary } from "./index.mjs";

export function preview() {
  return JSON.stringify(stopSummary(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
