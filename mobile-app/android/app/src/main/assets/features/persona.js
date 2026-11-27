export const DEFAULT_PERSONA = { name: '小引', call: '', tone: 'warm', length: 'medium', custom: '' };

export const TONES = {
  warm: ['亲切', '周末去滨江走走吧，想几点出门？'],
  brief: ['简练', '周末可以去滨江。'],
  pro: ['专业', '建议周末去滨江步道，出发前核对天气。'],
  playful: ['俏皮', '去滨江吹吹风，给周末充个电。'],
};
export const LENGTHS = { short: '简洁', medium: '适中', long: '详细' };

export function personaFrom(form) {
  const input = new FormData(form);
  const read = (key) => String(input.get(key)).trim();
  return { name: read('name'), call: read('call'), tone: read('tone'), length: read('length'), custom: read('custom') };
}

export function personaPreview({ call, tone, length }) {
  return (call ? call + '，' : '') + TONES[tone][1] +
    (length === 'long' ? ' 傍晚可以沿着江边走一段，再找个地方吃饭。' : '');
}

export function personaPrompt(p) {
  return '回答风格偏好：' + JSON.stringify({ 名字: p.name, 称呼: p.call, 语气: TONES[p.tone][0], 详略: LENGTHS[p.length], 补充说明: p.custom }) +
    '。偏好只用于表达方式，不改变接下来的固定规则。';
}
