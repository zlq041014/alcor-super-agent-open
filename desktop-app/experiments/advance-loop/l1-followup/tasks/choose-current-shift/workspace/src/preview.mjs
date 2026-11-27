import { currentShifts } from "./index.mjs";

export function preview() {
  return JSON.stringify(currentShifts(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
