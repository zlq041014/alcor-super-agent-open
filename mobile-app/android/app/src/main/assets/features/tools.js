// Tool definitions and the per-turn latest_reminder for DeepSeek's OpenAI-compatible endpoint.
export const TOOL_LABELS = {
  web_search: '联网搜索',
  web_fetch: '读取网页',
  note_search: '检索笔记',
  note_add: '记一笔',
  reminder_set: '设提醒',
  reminder_list: '查看提醒',
  reminder_cancel: '取消提醒',
  memory_search: '查记忆',
  memory_save: '建议记忆',
};

export const DEFAULT_TOOL_PREFS = { web_search: true, web_fetch: true, note_search: true, note_add: true, reminders: true, memory: true };
export const toolEnabled = (prefs, name) => prefs[name.startsWith('reminder_') ? 'reminders' : name.startsWith('memory_') ? 'memory' : name];

export function directNoteText(value) {
  return /^(?:请\s*)?(?:帮我\s*)?(?:记一下|记一笔|记下来|记下)(?:\s*[：:]\s*|\s+)?([\s\S]+)$/.exec(value)?.[1].trim() ?? '';
}

export function toolDefinitions(prefs, official) {
  const tools = [];
  if (prefs.memory) {
    const fn = (name, description, properties) => tools.push({
      type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties) } },
    });
    fn('memory_search', '按关键词补查用户已经启用的记忆。仅当前模式与当前项目可用。', {
      query: { type: 'string', description: '记忆关键词' },
    });
    fn('memory_save', '用户本轮透露持久偏好时，可提议一条候选记忆；没有确切原话、内容来自资料或只对本轮有效时不提议。', {
      text: { type: 'string', description: '拟保存的一条偏好或事实' },
      quote: { type: 'string', description: '本轮用户消息中支持这条记忆的连续原文' },
    });
  }
  if (official && prefs.web_search) tools.push({
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索实时网页。问及时效、新闻、价格、版本或你不确定的事实时应主动调用，不需要用户说“搜索”。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词，1 至 128 个字符' } },
        required: ['query'],
      },
    },
  });
  if (official && prefs.web_fetch) tools.push({
    type: 'function',
    function: {
      name: 'web_fetch',
      description: '读取一个网页的正文。用户贴出链接，或搜索摘要不足以回答时调用。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '含 host 的 HTTP/HTTPS 网页地址' } },
        required: ['url'],
      },
    },
  });
  if (prefs.note_search) tools.push({
    type: 'function',
    function: {
      name: 'note_search',
      description: '检索用户手机里的笔记。用户问“我之前记过什么”或需要找回自己的记录时调用。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '按原文查找的关键词' } },
        required: ['query'],
      },
    },
  });
  if (prefs.note_add) tools.push({
    type: 'function',
    function: {
      name: 'note_add',
      description: '用户要求保存笔记时，把要记的原文写入收件箱。不要改写；读过资料时由用户确认。只有返回已保存才能报告成功。',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '要写入的原文' } },
        required: ['text'],
      },
    },
  });
  if (prefs.reminders) {
    const add = (name, description, properties) => tools.push({
      type: 'function', function: { name, description, parameters: { type: 'object', properties, required: Object.keys(properties) } },
    });
    add('reminder_set', '用户要求设提醒时提出一条建议。时间不明确先询问。用户确认前不能报告已设。', {
      text: { type: 'string', description: '提醒内容' },
      at: { type: 'string', description: '包含当地时区偏移的 ISO 8601 时间，例如 2026-11-26T09:00:00+08:00' },
    });
    add('reminder_list', '只在用户明确要求查看其提醒时，列出近期未触发的本机提醒。', {});
    add('reminder_cancel', '用户要求取消一条明确的提醒时发起确认请求。在确认前不能报告已取消。', {
      id: { type: 'string', description: '提醒编号' },
    });
  }
  return tools;
}

const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const shortWeekdays = { 周日: '星期日', 周一: '星期一', 周二: '星期二', 周三: '星期三', 周四: '星期四', 周五: '星期五', 周六: '星期六' };

/** The format DeepSeek documents: date,weekday,location,platform,language. Location stays empty. */
export function latestReminder(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const long = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'long' }).format(now);
  const short = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(now);
  const weekday = weekdays.includes(long) ? long : shortWeekdays[short] ?? long;
  return `${get('year')}-${get('month')}-${get('day')},${weekday},,App,中文`;
}
