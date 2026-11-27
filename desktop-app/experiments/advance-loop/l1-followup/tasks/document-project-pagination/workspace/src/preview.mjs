import { pageProjects } from "./index.mjs";

export function preview() {
  return JSON.stringify(pageProjects(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
