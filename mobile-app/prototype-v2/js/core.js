/* 基础工具、词表、示例数据和状态工厂。全部内容是示例：不连接模型、Hub 或执行端。 */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const A = n => `assets/${n}.png`;
let uidN = 0;
const uid = p => `${p}${++uidN}`;
const kfmt = n => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
const yuan = v => `¥${v < 0.01 ? v.toFixed(4) : v < 1 ? v.toFixed(3) : v.toFixed(2)}`;

/* 正文排版：只做原型需要的几种 Markdown。 */
function md(src) {
  const inline = t => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[(\d+)\]/g, '<sup class="cite">$1</sup>');
  const out = [];
  let list = null;
  for (const line of String(src).split('\n')) {
    const ul = /^[-•]\s+(.*)/.exec(line), ol = /^\d+[.、]\s+(.*)/.exec(line);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { if (list) out.push(`</${list}>`); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list}>`); list = null; }
    if (/^#{1,3}\s/.test(line)) out.push(`<h4>${inline(line.replace(/^#{1,3}\s/, ''))}</h4>`);
    else if (line.trim() === '') out.push('<div class="gapline"></div>');
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push(`</${list}>`);
  return out.join('');
}

/* ---------- 词表 ---------- */
// 单价来自设计文档「模型接入」一节（高峰价，每百万 token，人民币）；搜索和抓取按次。
const PRICE = { checked: '2026-11-25', flash: { miss: 2, hit: 0.04, out: 8 }, pro: { miss: 9, hit: 0.3, out: 27 }, search: 0.005, fetch: 0.005 };
function costOf(u) {
  const p = PRICE[u.model || 'flash'];
  return (u.hit * p.hit + u.miss * p.miss + (u.out + (u.think || 0)) * p.out) / 1e6 + (u.search || 0) * PRICE.search + (u.fetch || 0) * PRICE.fetch;
}
const MODELS = {
  flash: { name: 'V4.1 Flash', short: 'Flash', api: 'deepseek-flash', caps: { 流式: 1, 工具调用: 1, 看图: 1, 思考强度: 1, 用量回报: 1 } },
  pro: { name: 'V4 Pro', short: 'Pro', api: 'deepseek-v4-pro', caps: { 流式: 1, 工具调用: 1, 看图: 0, 思考强度: 1, 用量回报: 1 } },
  custom: { name: '自定义网关', short: '自定义', api: '', caps: { 流式: 1, 工具调用: -1, 看图: -1, 思考强度: -1, 用量回报: -1 } },
};
const THINK = { off: '关闭', low: 'Low', high: 'High', max: 'Max' };

// 状态文案沿用 mobile-manager-v1.md「让等待可理解」；pet 是 desktop-pet.md 里对应的动作。
const STAGE = {
  draft: { label: '等你确认', short: '等你确认', tone: 'gray', step: 0 },
  local: { label: '已记下，等电脑上线', short: '已记下', tone: 'gray', step: 1, pet: 'queued', who: '等电脑上线' },
  sending: { label: '核对后发送中', short: '发送中', tone: 'gray', step: 1, pet: 'queued', who: '正在核对身份、授权和版本' },
  received: { label: '电脑已收到，等待执行', short: '电脑已收到', tone: 'blue', step: 2, pet: 'received', who: '等执行端开始' },
  verify: { label: '送达待核对', short: '送达待核对', tone: 'amber', step: 2, pet: 'unknown', mark: 'warn', who: '按原请求核对，不重发' },
  running: { label: '执行中', short: '执行中', tone: 'amber', step: 3, pet: 'working', who: '等执行端做完' },
  review: { label: '待验收', short: '待验收', tone: 'violet', step: 4, pet: 'review', who: '等你核对' },
  done: { label: '已完成', short: '已完成', tone: 'green', step: 5 },
  failed: { label: '执行失败', short: '执行失败', tone: 'red', step: 3, pet: 'failed', mark: 'bad', who: '等你决定怎么办' },
  cancelled: { label: '已撤销，未派发', short: '已撤销', tone: 'gray', step: 0 },
};
const STEPS = ['已记下', '电脑已收到', '执行中', '待验收', '已完成'];
const PET_ORDER = ['failed', 'unknown', 'review', 'working', 'received', 'queued'];
const EXEC = { codex: { label: 'Codex', img: 'exec-codex' }, dsh: { label: 'DSH', img: 'exec-dsh' } };
const KIND = {
  mgr: { label: '总管', tag: 'mgr' },
  chat: { label: '对话', tag: 'chat', img: 'phone-assistant' },
  codex: { label: 'Codex', tag: 'codex', img: 'exec-codex' },
  dsh: { label: 'DSH', tag: 'dsh', img: 'exec-dsh' },
};
const ROUTE = {
  direct: { label: '直连', tone: 'green', icon: 'wifi', rank: 1 },
  relay: { label: '自有中继', tone: 'blue', icon: 'cloud', rank: 2 },
  tunnel: { label: '第三方隧道', tone: 'amber', icon: 'route', rank: 3 },
};
// g 是权限页上的分组；界面只显示图标和名称。
const TOOLS = {
  web_search: { label: '联网搜索', icon: 'search', g: 'net' },
  web_fetch: { label: '读取链接', icon: 'link', g: 'net' },
  weather: { label: '天气与预警', icon: 'rain', g: 'net', pending: true },
  note_search: { label: '检索笔记', icon: 'note', g: 'local' },
  note_add: { label: '记一笔', icon: 'pen', g: 'local' },
  reminder: { label: '提醒', icon: 'alarm', g: 'local' },
  memory: { label: '记忆', icon: 'jar', g: 'local' },
  place_now: { label: '当前位置', icon: 'pin', g: 'device' },
  calendar_read: { label: '读日程', icon: 'cal', g: 'device' },
};
const TOOL_GROUPS = [['net', '联网'], ['local', '本机'], ['device', '设备']];
const SYSPERM = { notify: '通知', exact: '精确定时', location: '位置（粗略）', mic: '麦克风', camera: '相机', calendar: '日历' };
const PERM_STATE = { granted: { label: '已允许', tone: 'green' }, denied: { label: '已拒绝', tone: 'red' }, unasked: { label: '用到时再问', tone: 'gray' } };
const EVT = {
  question: { label: '等你回答', tone: 'amber' },
  review: { label: '待验收', tone: 'violet' },
  failed: { label: '执行失败', tone: 'red' },
  verify: { label: '送达待核对', tone: 'amber' },
  done: { label: '已完成', tone: 'green' },
  reminder: { label: '提醒', tone: 'blue' },
  weather: { label: '天气', tone: 'blue' },
};
const ASTATE = {
  online: { label: '在线', tone: 'green' }, idle: { label: '空闲', tone: 'gray' }, running: { label: '执行中', tone: 'amber' },
  review: { label: '待验收', tone: 'violet' }, done: { label: '已完成', tone: 'green' }, failed: { label: '失败', tone: 'red' },
  wait: { label: '等前置', tone: 'gray' }, question: { label: '等你回答', tone: 'amber' }, queued: { label: '排队中', tone: 'blue' },
  none: { label: '未开始', tone: 'gray' }, unknown: { label: '待核对', tone: 'amber' },
};

/* ---------- 示例数据 ---------- */
const PROJECTS = {
  'alcor-web': { id: 'alcor-web', name: 'alcor-web', device: 'work', desc: '官网与登录流程', sync: '今天 08:12' },
  'alcor-web@home': { id: 'alcor-web@home', name: 'alcor-web', device: 'home', desc: '同名项目 · 接口联调用的副本', sync: '10:21' },
  'weekly-report': { id: 'weekly-report', name: 'weekly-report', device: 'home', desc: '每周数据周报脚本', sync: '10:21' },
  'alcor-site': { id: 'alcor-site', name: 'alcor-site', device: 'home', desc: '产品站与定价页', sync: '10:21' },
  'alcor-super-agent': { id: 'alcor-super-agent', name: 'alcor-super-agent', device: 'home', desc: '星引本体', sync: '10:21' },
};
// d 是层级；task 为 true 的节点状态取自手机上这项交接的回执。
const AGENTS = {
  'alcor-web': [
    { id: 'a0', d: 0, role: '总管', name: '总管', exec: 'mgr', model: 'deepseek-flash · max', state: 'online', act: '10:20' },
    { id: 'a1', d: 1, role: '讨论', name: '登录页改版', exec: 'chat', model: 'deepseek-flash · max', state: 'idle', act: '昨天 21:40', conv: 'd-login' },
    { id: 'a2', d: 2, role: '执行', name: '登录页按钮文案', exec: 'codex', model: 'Codex 原会话', state: 'none', act: '—', task: true },
    { id: 'a3', d: 3, role: '核对', name: '只读核对成员', exec: 'codex', model: 'Codex 托管 · 只读', state: 'wait', act: '—' },
    { id: 'a4', d: 1, role: '执行', name: '登录页无障碍检查', exec: 'dsh', model: 'deepseek-flash · max', state: 'done', act: '周一 17:32' },
  ],
  'weekly-report': [
    { id: 'b0', d: 0, role: '总管', name: '总管', exec: 'mgr', model: 'deepseek-flash · max', state: 'online', act: '10:20' },
    { id: 'b1', d: 1, role: '执行', name: '周报生成脚本', exec: 'dsh', model: 'deepseek-flash · max', state: 'question', act: '09:50', conv: 'h-weekly' },
  ],
  'alcor-site': [
    { id: 'c0', d: 0, role: '总管', name: '总管', exec: 'mgr', model: 'deepseek-flash · max', state: 'online', act: '10:20' },
    { id: 'c1', d: 1, role: '讨论', name: '定价页方案', exec: 'chat', model: 'deepseek-flash · max', state: 'idle', act: '周一', conv: 'd-pricing' },
    { id: 'c2', d: 2, role: '执行', name: '定价页文案对比表', exec: 'dsh', model: 'deepseek-flash · max', state: 'done', act: '昨天 18:20' },
  ],
  'alcor-super-agent': [
    { id: 'd0', d: 0, role: '总管', name: '总管', exec: 'mgr', model: 'deepseek-flash · max', state: 'online', act: '10:20' },
    { id: 'd1', d: 1, role: '执行', name: '手机首版交互', exec: 'dsh', model: 'deepseek-flash · max', state: 'running', act: '10:02', conv: 'h-mobile' },
  ],
  'alcor-web@home': [
    { id: 'e0', d: 0, role: '总管', name: '总管', exec: 'mgr', model: 'deepseek-flash · max', state: 'online', act: '10:20' },
  ],
};
const NATIVE = {
  'alcor-web': [{ conv: 'c-login', exec: 'codex', name: '登录页重构', act: '昨天 20:58' }],
  'alcor-web@home': [{ conv: 'c-api', exec: 'codex', name: '登录接口联调', act: '11-20' }],
};
const WX = {
  city: '上海', now: '多云', temp: 15, hi: 17, lo: 11, rainAt: '18:00', rainEnd: '21:00',
  hours: [['10', 'cloud', 15], ['12', 'cloud', 17], ['14', 'cloud', 17], ['16', 'cloud', 16], ['18', 'rain', 14], ['20', 'rain', 12], ['22', 'cloud', 11]],
};
const USAGE = {
  today: 0.42, month: 9.86,
  days: [['周四', 0.31], ['周五', 0.58], ['周六', 0.12], ['周日', 0.2], ['周一', 0.74], ['周二', 0.49], ['今天', 0.42]],
  parts: [['输入 · 命中缓存', 0.05], ['输入 · 未命中', 0.14], ['输出与思考', 0.17], ['搜索与抓取', 0.05], ['语音转写', 0.01]],
};

function seedComputers() {
  return {
    work: {
      id: 'work', name: 'LAPTOP-8F2M4C', remark: '', os: 'Windows 11 · 星引桌面 0.2.1', online: false, last: '昨天 23:10', route: null, paired: '11-24',
      routes: [
        { k: 'direct', detail: '局域网', ok: false, note: '不在同一个局域网' },
        { k: 'relay', detail: '你的云主机，只转发密文', ok: false, note: '电脑没有连上中继' },
        { k: 'tunnel', detail: '没有填写', ok: null, note: '可选' },
      ],
    },
    home: {
      id: 'home', name: 'DESKTOP-3K7Q2H', remark: '家里台式机', os: 'Windows 11 · 星引桌面 0.2.1', online: true, last: '在线', route: 'relay', paired: '11-24',
      routes: [
        { k: 'direct', detail: '局域网', ok: false, note: '不在同一个局域网' },
        { k: 'relay', detail: '你的云主机，只转发密文', ok: true, ms: 24 },
        { k: 'tunnel', detail: '组网工具给出的地址', ok: true, ms: 420 },
      ],
    },
  };
}
const computerLabel = c => (c.remark || '').trim() || c.name;
function setOnline(c, route) {
  c.online = !!route; c.route = route || null; c.last = route ? '在线' : '刚刚';
  for (const r of c.routes) {
    if (r.k === 'tunnel' && r.ok === null) continue;
    const rank = ROUTE[r.k].rank, cur = route ? ROUTE[route].rank : 9;
    r.ok = !!route && rank >= cur;
    r.ms = r.ok ? { direct: 8, relay: 24, tunnel: 420 }[r.k] : undefined;
    r.note = r.ok ? '' : (route ? '不在同一个局域网' : '电脑不在线');
  }
}

function seedConvs() {
  const s = (src, role, text) => ({ id: uid('m'), role, text, synced: true, src });
  const sample = { kind: 'gap', text: '原型只为几场对话准备了完整内容，这一场只有名片' };
  return {
    'home-work': { id: 'home-work', mode: 'work', kind: 'mgr', title: '总管', time: '10:20', recent: '登录按钮文案长度', used: 99, msgs: [] },
    'home-life': { id: 'home-life', mode: 'life', kind: 'mgr', title: '总管', time: '08:05', recent: '今天要带伞吗', used: 99, msgs: [] },
    'd-login': {
      id: 'd-login', mode: 'work', kind: 'chat', title: '登录页改版', project: 'alcor-web', time: '昨天 21:40', recent: '按钮文案三个方案', used: 8, titled: true,
      msgs: [
        { kind: 'day', text: '昨天' },
        s('LAPTOP-8F2M4C · 21:32', 'user', '登录页主按钮现在叫「立即登录并进入工作台」，太长了，想短一点。'),
        s('LAPTOP-8F2M4C · 21:40', 'ai', '可以考虑三个方向：\n1. 「登录」最直接\n2. 「进入工作台」强调去处\n3. 「继续」和注册流程用词一致\n我倾向 3，但要看你是否在意它和“下一步”的区分。'),
        { kind: 'sys', text: '以上同步于今天 08:12 · 之后电脑上没有新记录' },
        { kind: 'gap', text: 'Codex「登录页重构」20:30–20:58 的正文没有同步' },
      ],
    },
    'c-login': {
      id: 'c-login', mode: 'work', kind: 'codex', title: '登录页重构', project: 'alcor-web', time: '昨天 20:58', recent: '拆分 LoginForm 组件', used: 7, titled: true,
      msgs: [
        { kind: 'day', text: '昨天 · 同步摘录' },
        s('Codex · 20:12', 'user', '把 LoginForm 拆成表单和提交按钮两个组件。'),
        s('Codex · 20:26', 'ai', '已拆分为 LoginFields 与 SubmitButton，测试全部通过。'),
        { kind: 'gap', text: '20:30–20:58 的正文没有同步（只有标题「调整按钮样式」）' },
        { kind: 'sys', text: 'Codex 原生会话的摘录。续聊请交给原窗口' },
      ],
    },
    'h-weekly': {
      id: 'h-weekly', mode: 'work', kind: 'dsh', title: '周报生成脚本', project: 'weekly-report', time: '09:50', recent: '有一个问题等你回答', used: 9, titled: true,
      msgs: [
        s('DSH · 09:41', 'user', '按上周的数据出周报，格式和以前一样。'),
        s('DSH · 09:50', 'ai', '上周数据缺 11-18、11-19 两天。按 5 天出，还是等补齐？'),
        { kind: 'ask', event: 'e1', q: '上周数据缺两天，周报怎么出？', opts: ['按 5 天出，注明缺口', '等数据补齐再出'] },
        { kind: 'sys', text: '同步于 10:21 · 家里台式机在线' },
      ],
    },
    'h-mobile': { id: 'h-mobile', mode: 'work', kind: 'dsh', title: '手机首版交互', project: 'alcor-super-agent', time: '前天', recent: '首屏只放对话', used: 5, titled: true, msgs: [{ kind: 'sys', text: 'DSH 原生会话 · alcor-super-agent · 最近：首屏只放对话' }, sample] },
    'd-pricing': { id: 'd-pricing', mode: 'work', kind: 'chat', title: '定价页方案', project: 'alcor-site', time: '周一', recent: '年付折扣怎么写', used: 4, titled: true, msgs: [{ kind: 'sys', text: '已挂到 alcor-site · 家里台式机 · 最近：年付折扣怎么写' }, sample] },
    'c-api': { id: 'c-api', mode: 'work', kind: 'codex', title: '登录接口联调', project: 'alcor-web@home', time: '11-20', recent: 'mock 服务返回 401', used: 3, titled: true, msgs: [{ kind: 'sys', text: 'Codex 原生会话 · alcor-web（家里台式机上的同名项目）' }, sample] },
    'n-relay': {
      id: 'n-relay', mode: 'work', kind: 'chat', title: '中继怎么讲清楚', time: '09:12', recent: '云主机只搬运密文', used: 6, titled: true,
      msgs: [
        { id: uid('m'), role: 'user', text: '我想把「手机经云主机连到电脑」讲清楚：云主机只转发，看不到内容。帮我理一下怎么说。', time: '09:10' },
        { id: uid('m'), role: 'ai', time: '09:12', text: '一句话版本：**云主机只搬运密文，钥匙只在手机和电脑手里。**\n- 加密在手机和电脑之间完成，云主机拿到的是打不开的包\n- 电脑主动连出去，不开放入站端口\n- 电脑不在线时，请求留在手机上待发，云主机不代存\n要不要画成一张图？', usage: { hit: 2100, miss: 900, out: 210, think: 380 }, mems: ['m5'] },
      ],
    },
    'l-weekend': {
      id: 'l-weekend', mode: 'life', kind: 'chat', title: '周末去哪儿走走', time: '10:24', recent: '周六午后出发的三个去处', used: 8, titled: true,
      msgs: [
        { id: uid('m'), role: 'user', text: '这周末上海适合去哪儿走走？不想太折腾。', time: '10:23' },
        {
          id: uid('m'), role: 'ai', time: '10:24',
          tools: [
            { t: 'web_search', arg: '上海 周末 天气 11月28日 29日', res: '5 条结果', ms: 1180 },
            { t: 'web_search', arg: '上海 近郊 半日 散步 路线 11月', res: '5 条结果', ms: 960 },
            { t: 'web_fetch', arg: 'city-walk.example/shanghai-autumn', res: '读到正文 6,200 字', ms: 1420 },
          ],
          text: '周六多云，周日下午转小雨[1]，建议把出门放在**周六**。按你周末早上不安排事情的习惯，下面都是午后出发、半天能回的：\n- **滨江步道**：平路，累了随时能撤，银杏这周正黄[2]\n- **植物园**：地铁可达，下雨也有温室可逛[3]\n- **水乡古镇**：人少的时候走一圈两小时，回程顺路吃饭[2]\n要不要我按其中一个排个下午的时间表？',
          sources: [
            { n: 1, title: '上海本周末天气预报', host: 'weather.example' },
            { n: 2, title: '十一月城市漫步路线', host: 'city-walk.example' },
            { n: 3, title: '植物园开放时间与交通', host: 'garden.example' },
          ],
          at: '10:24', usage: { hit: 9800, miss: 3400, out: 540, think: 820, search: 2, fetch: 1 }, mems: ['m2'],
        },
      ],
    },
    'l-dinner': {
      id: 'l-dinner', mode: 'life', kind: 'chat', title: '晚饭吃什么', time: '11-20', recent: '记住我不吃香菜', used: 5, titled: true,
      msgs: [
        { id: uid('m'), role: 'user', text: '记住我不吃香菜。', time: '18:40' },
        { id: uid('m'), role: 'ai', time: '18:40', tools: [{ t: 'memory', arg: '不吃香菜 · 生活', res: '已保存', ms: 40 }], text: '记住了。以后推荐吃的会避开香菜。', usage: { hit: 1800, miss: 300, out: 60, think: 120 } },
        { kind: 'saved', what: 'mem', text: '不吃香菜', ref: 'm1' },
      ],
    },
    'l-trip': {
      id: 'l-trip', mode: 'life', kind: 'chat', title: '崇明看日出', time: '周日', recent: '轮渡时间和穿什么', used: 4, titled: true,
      msgs: [
        { kind: 'summary', n: 46, ver: 2, points: ['已定：12 月 5 日周六去，坐最早一班轮渡，不住宿', '你的要求（原话）：“不想凌晨三点起，最晚四点半出门”', '未定：回程在岛上吃还是回市区吃', '用过的材料：轮渡时刻页 1 个、笔记「周末去崇明看日出」'] },
        { id: uid('m'), role: 'user', text: '那天早上会不会很冷，要穿什么？', time: '周日 20:12' },
        { id: uid('m'), role: 'ai', time: '周日 20:12', text: '按最早一班轮渡算，你在码头等船的时候是全天最冷的一段。建议：\n- 外层防风，里面一件抓绒就够，上岛走起来会热\n- 手套比帽子有用，拍照要一直露着手\n具体温度到出发前三天我再查，现在的预报不准。', usage: { hit: 21400, miss: 700, out: 190, think: 260 } },
      ],
    },
  };
}

function seedNotes() {
  return [
    { id: 'n1', mode: 'work', text: '登录页主按钮文案太长。试试「继续」，和注册流程的用词一致。', time: '今天 08:52', via: '主屏幕小组件', box: 'inbox' },
    { id: 'n2', mode: 'work', text: '', audio: { len: '0:27', state: 'done', text: '周报脚本里，缺数据的那两天要不要标灰，还是直接按五天出，得问一下大家平时怎么看。' }, time: '今天 08:31', via: '语音', box: 'inbox' },
    { id: 'n3', mode: 'work', text: 'https://design.example/login-patterns', link: { title: '登录页设计模式 12 例', host: 'design.example' }, time: '昨天 22:10', via: '分享自浏览器', box: 'inbox', derive: { tags: ['登录页', '参考'], sum: '收集了 12 种登录页布局和按钮文案的写法。', rel: '对话「登录页改版」' } },
    { id: 'n4', mode: 'work', text: '白板：手机 → 中继 → Hub，中继只搬密文。', img: '白板照片', time: '昨天 16:40', via: '拍照', box: 'filed', project: 'alcor-super-agent', derive: { tags: ['跨网络', '架构'] } },
    { id: 'n5', mode: 'work', text: '周五前把定价页的年付折扣文案定下来。', time: '周一 19:05', via: '对话里记下', box: 'filed', project: 'alcor-site', remind: '周五 10:00' },
    { id: 'n6', mode: 'life', text: '周末去崇明看日出，查一下最早一班轮渡。', time: '今天 07:48', via: '主屏幕小组件', box: 'inbox' },
    { id: 'n7', mode: 'life', text: '妈妈生日 12 月 6 日，提前订蛋糕。', time: '昨天 21:15', via: '应用内', box: 'inbox', remind: '12-04 10:00' },
    { id: 'n8', mode: 'life', text: '', audio: { len: '0:14', state: 'failed' }, time: '昨天 18:02', via: '语音', box: 'inbox' },
    { id: 'n9', mode: 'life', text: 'https://recipes.example/tomato-beef', link: { title: '番茄牛腩，少油版', host: 'recipes.example' }, time: '周日 20:30', via: '分享自浏览器', box: 'inbox', derive: { tags: ['菜谱'], sum: '炖 90 分钟，番茄分两次下。' } },
    { id: 'n10', mode: 'life', text: '阳台的薄荷该换盆了。', time: '周六 09:12', via: '应用内', box: 'archived' },
  ];
}
function seedMems() {
  return [
    { id: 'm1', scope: 'life', text: '不吃香菜', kind: 'explicit', src: '11-20 对话「晚饭吃什么」', used: '昨天', on: true },
    { id: 'm2', scope: 'life', text: '周末早上不安排事情', kind: 'explicit', src: '11-16 对话「周末计划」', used: '今天', on: true },
    { id: 'm3', scope: 'life', text: '口味偏清淡，少油', kind: 'explicit', src: '笔记「番茄牛腩，少油版」', used: '周日', on: true },
    { id: 'm4', scope: 'life', text: '喝奶茶要换燕麦奶', kind: 'cand', src: '今天你提到乳糖不耐', on: false },
    { id: 'm5', scope: 'work', text: '答复先给结论，再给依据', kind: 'explicit', src: '11-19 总管对话', used: '今天', on: true },
    { id: 'm6', scope: 'work', text: '周五下午不排评审', kind: 'cand', src: '最近两次改期都避开了', on: false },
    { id: 'm7', scope: 'project', project: 'alcor-web', text: '按钮文案用动词开头，不超过四个字', kind: 'explicit', src: '11-24 对话「登录页改版」', used: '昨天', on: true },
    { id: 'm8', scope: 'work', text: '提交说明用中文', kind: 'explicit', src: '11-18 总管对话', used: '11-22', on: false },
  ];
}
function seedRems() {
  return [
    { id: 'r1', mode: 'life', text: '给妈妈回电话', when: '今天 19:30', src: '对话里设定', on: true },
    { id: 'r2', mode: 'life', text: '订生日蛋糕', when: '12-04 10:00', src: '笔记「妈妈生日 12 月 6 日」', on: true },
    { id: 'r3', mode: 'life', text: '薄荷换盆', when: '上周六 09:00', src: '笔记', on: false, done: true },
    { id: 'r4', mode: 'work', text: '看 Codex 的登录页改动', when: '今天 14:00', src: '对话「登录页改版」', on: true },
    { id: 'r5', mode: 'work', text: '定价页年付折扣文案', when: '周五 10:00', src: '笔记', on: true },
  ];
}
function seedEvents() {
  return [
    { id: 'e1', mode: 'work', type: 'question', title: '上周数据缺两天，周报怎么出？', sub: '周报生成脚本 · 家里台式机', time: '09:50', unread: true, open: true, conv: 'h-weekly', exec: 'dsh' },
    { id: 'e2', mode: 'work', type: 'done', title: '定价页文案对比表', sub: 'alcor-site · 家里台式机', time: '昨天 18:20', unread: false, open: false, conv: 'd-pricing', exec: 'dsh' },
    { id: 'e3', mode: 'life', type: 'weather', title: '18:00 后有雨，出门带伞', sub: '上海 · 尽量送达', time: '07:30', unread: true, open: false },
    { id: 'e4', mode: 'life', type: 'reminder', title: '薄荷换盆', sub: '上周六 09:00 · 已看过', time: '上周六', unread: false, open: false },
  ];
}
function seedSettings() {
  return {
    provider: 'official', model: 'flash', think: 'high', search: 'official',
    persona: { name: '小引', call: '阿霖', tone: 'warm', verbose: 1, custom: '', aiGreet: false },
    tools: { web_search: true, web_fetch: true, note_search: true, note_add: true, reminder: true, memory: true, place_now: false, weather: false, calendar_read: false },
    sys: { notify: 'granted', exact: 'denied', location: 'unasked', mic: 'granted', camera: 'unasked', calendar: 'unasked' },
    notif: { reminder: true, weather: true, work: true, quiet: true },
    budget: 80000, dayLimit: 3, lock: false, brief: false, autoTidy: false,
    pet: { show: true, dnd: false }, city: '上海',
  };
}

/* ---------- 状态 ---------- */
let S;
function freshState(prev) {
  return {
    mode: 'work', theme: prev ? prev.theme : 'light', reduce: prev ? prev.reduce : false,
    net: true, ready: true, clock: '10:24', part: 'am', date: '11月25日 周三',
    stack: [{ n: 'home' }], drawer: false, sheet: null, toast: null, snack: null, locked: false, enter: '',
    input: {}, mats: {}, typing: false, busy: null, sugg: null,
    computers: seedComputers(), convs: seedConvs(), notes: seedNotes(), mems: seedMems(), rems: seedRems(), events: seedEvents(), tasks: {},
    set: seedSettings(), pet: { shot: null, drag: false, sleep: false },
    tabs: { sessions: 'recent', notes: 'inbox', mem: 'life', project: 'tree', rem: 'next' },
    q: '', scripts: [], flags: {}, stick: true,
  };
}
const cur = () => S.stack[S.stack.length - 1];
const homeId = () => `home-${S.mode}`;
const curConvId = () => (cur().n === 'chat' ? cur().id : cur().n === 'home' ? homeId() : null);
const onlineCount = () => Object.values(S.computers).filter(c => c.online).length;
const taskList = () => Object.values(S.tasks);
const liveTasks = () => taskList().filter(t => !['draft', 'done', 'cancelled'].includes(t.stage));
const unreadCount = mode => S.events.filter(e => e.mode === mode && e.unread).length;
const openEvents = mode => S.events.filter(e => e.mode === mode && e.open);
const PARTS = { am: '上午好', noon: '中午好', pm: '下午好', eve: '晚上好', night: '夜深了' };
const greeting = () => (S.set.persona.call ? `${PARTS[S.part]}，${S.set.persona.call}` : `${PARTS[S.part]}`);
function now() {
  const [h, m] = S.clock.split(':').map(Number);
  S.tick = (S.tick || 0) + 1;
  if (S.tick % 3 === 0) { const t = h * 60 + m + 1; S.clock = `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
  return S.clock;
}
