import {normalizeTags} from "./tags.mjs";
import {separator} from "./settings.mjs";
export function filterTags(values) { return normalizeTags(values); }
export function exportTags(values) { return normalizeTags(values).join(separator); }
