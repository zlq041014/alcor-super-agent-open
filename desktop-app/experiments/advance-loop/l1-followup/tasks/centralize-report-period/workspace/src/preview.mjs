import { weeklyHeading } from "./index.mjs";

export function preview() {
  return JSON.stringify(weeklyHeading(...welcome), null, 2);
}

import { welcome } from "./sample.mjs";
