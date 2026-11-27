import { nextReminder } from "./index.mjs";

export function preview() {
  return JSON.stringify(nextReminder(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
