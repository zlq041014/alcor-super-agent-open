export const WORK = 'work', LIFE = 'life';
export const homeId = (mode) => mode === LIFE ? 'home:life' : 'home';
export const dialogMode = (d) => d.id === 'home:life' || d.id.startsWith('life:discussion:') ? LIFE : WORK;
export const lastKey = (mode) => mode === LIFE ? 'lastLifeDiscussion' : 'lastDiscussion';
export const toolPrefs = (data, mode) => mode === LIFE ? data.lifeToolPrefs : data.toolPrefs;
export const inMode = (d, mode) => d && dialogMode(d) === mode;
