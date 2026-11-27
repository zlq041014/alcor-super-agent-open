import { calendar } from './calendar.mjs';
import { details } from './details.mjs';
export function execute({ screen, input }) { return screen === 'calendar' ? calendar(input) : details(input); }
