import { filterTags } from "./index.mjs";

export function preview() {
  return JSON.stringify(filterTags(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
