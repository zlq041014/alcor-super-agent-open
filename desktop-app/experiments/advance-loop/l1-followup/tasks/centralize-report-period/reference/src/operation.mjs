import {formatPeriod} from "./period.mjs";
export function weeklyHeading(first, last) { return "周报 · " + formatPeriod(first,last); }
export function monthlyHeading(first, last) { return "月报 · " + formatPeriod(first,last); }
