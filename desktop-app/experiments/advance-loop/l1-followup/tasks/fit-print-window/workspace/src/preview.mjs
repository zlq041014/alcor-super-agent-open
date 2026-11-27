import { pageWindow } from "./index.mjs";

export function preview() {
  return JSON.stringify(pageWindow(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
