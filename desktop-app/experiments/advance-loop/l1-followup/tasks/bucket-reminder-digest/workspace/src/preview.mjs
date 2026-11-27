import { reminderDigest } from "./index.mjs";

export function preview() {
  return JSON.stringify(reminderDigest(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
