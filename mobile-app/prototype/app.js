'use strict';

/* ================= 基础 ================= */
const A = n => `assets/${n}.png`;
const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  up: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  clip: '<path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10.2 17.7a1.7 1.7 0 0 1-2.4-2.4L15.5 7.6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  wifi: '<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/>',
  wifioff: '<path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/><path d="M3 3l18 18"/>',
  battery: '<rect x="2" y="7" width="18" height="10" rx="2"/><path d="M22 11v2"/><rect x="4" y="9" width="11" height="6" rx="1" fill="currentColor" stroke="none"/>',
  signal: '<path d="M4 18v-2M9 18v-5M14 18V9M19 18V5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  ext: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6l-7-3Z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const ic = (n, cls = '') => `<svg class="i ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const $ = s => document.querySelector(s);

let gen = 0;
const sleep = ms => new Promise((res, rej) => { const g = gen; setTimeout(() => (g === gen ? res() : rej('stale')), ms); });
const quiet = p => p && p.catch && p.catch(e => { if (e !== 'stale') console.error(e); });

let minute = 10 * 60 + 24, ticks = 0;
const pad = n => String(n).padStart(2, '0');
function now() { if (++ticks % 3 === 0) minute++; return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`; }
let uid = 0;
const id = p => `${p}${++uid}`;

const EXEC = { codex: { label: 'Codex', img: 'exec-codex', tag: 'codex' }, dsh: { label: 'DSH', img: 'exec-dsh', tag: 'dsh' } };
const STAGE = {
  local: { cls: 'st-local', label: '已记下，等电脑上线', step: 1 },
  sending: { cls: 'st-local', label: '核对后发送中', step: 1 },
  queued: { cls: 'st-queued', label: '电脑已收到，等待执行', step: 2 },
  verify: { cls: 'st-verify', label: '送达待核对', step: 2, mark: 'warn' },
  running: { cls: 'st-running', label: '执行中', step: 3 },
  review: { cls: 'st-review', label: '待验收', step: 4 },
  done: { cls: 'st-done', label: '已完成', step: 5 },
  failed: { cls: 'st-failed', label: '执行失败', step: 3, mark: 'bad' },
  cancelled: { cls: 'st-cancelled', label: '已撤销，未派发', step: 0 },
};

/* ================= 数据 ================= */
const SESSIONS = [
  { id: 'm-today', kind: 'mgr', title: '总管 · 今天', project: null, device: '手机', recent: '登录按钮文案长度', time: '10:20', used: 9 },
  { id: 'h-weekly', kind: 'dsh', title: '周报生成脚本', project: 'weekly-report', device: '家里台式机', recent: '有一个问题等你回答', time: '09:50', used: 8 },
  { id: 'd-login', kind: 'disc', title: '登录页改版', project: 'alcor-web', device: '工作电脑', recent: '按钮文案三个方案', time: '昨天 21:40', used: 7 },
  { id: 'c-login', kind: 'codex', title: '登录页重构', project: 'alcor-web', device: '工作电脑', recent: '拆分 LoginForm 组件', time: '昨天 20:58', used: 6, gap: true },
  { id: 'h-mobile', kind: 'dsh', title: '手机首版交互', project: 'alcor-super-agent', device: '家里台式机', recent: '首屏只放对话', time: '前天', used: 5 },
  { id: 'd-pricing', kind: 'disc', title: '定价页方案', project: 'alcor-site', device: '家里台式机', recent: '年付折扣怎么写', time: '周一', used: 4 },
  { id: 'c-api', kind: 'codex', title: '登录接口联调', project: 'alcor-web', device: '家里台式机', recent: 'mock 服务返回 401', time: '11-20', used: 3 },
  { id: 'u-1', kind: 'none', title: '未命名会话', project: null, device: '工作电脑', recent: '目录推断可能属于 alcor-web（低置信，不作自动派发依据）', time: '11-18', used: 2 },
];
const KIND = {
  mgr: { label: '总管对话', tag: 'mgr', img: 'avatar' },
  disc: { label: '项目讨论', tag: 'disc', img: 'decision' },
  codex: { label: 'Codex 会话', tag: 'codex', img: 'exec-codex' },
  dsh: { label: 'DSH 会话', tag: 'dsh', img: 'exec-dsh' },
  none: { label: '未归类', tag: 'none', img: 'find-sessions' },
};

function makeDiscs() {
  const s = (src, role, text) => ({ id: id('m'), role, text, synced: true, src });
  return {
    'd-login': { title: '登录页改版', kind: 'disc', project: 'alcor-web', device: '工作电脑', msgs: [
      { kind: 'day', text: '昨天' },
      s('工作电脑 · 21:32', 'user', '登录页主按钮现在叫「立即登录并进入工作台」，太长了，想短一点。'),
      s('工作电脑 · 21:40', 'manager', '可以考虑三个方向：\n1.「登录」最直接\n2.「进入工作台」强调去处\n3.「继续」和注册流程用词一致\n我倾向 3，但要看你是否在意它和“下一步”区分。'),
      { kind: 'sys', text: '以上同步于今天 08:12 · 之后电脑上没有新记录' },
      { kind: 'gap', text: 'Codex「登录页重构」20:30–20:58 的正文未同步，只有标题，不据此补写' },
    ] },
    'c-login': { title: '登录页重构', kind: 'codex', project: 'alcor-web', device: '工作电脑', msgs: [
      { kind: 'day', text: '昨天 · 同步摘录' },
      s('Codex · 20:12', 'user', '把 LoginForm 拆成表单和提交按钮两个组件。'),
      s('Codex · 20:26', 'manager', '已拆分为 LoginFields 与 SubmitButton，测试全部通过。'),
      { kind: 'gap', text: '20:30–20:58 正文未同步（只有标题「调整按钮样式」）' },
      { kind: 'sys', text: '这是 Codex 原生会话的摘录。在这里说的话会另存为围绕它的讨论，不写入原生历史；续聊要交给工作电脑上的原会话' },
    ] },
    'h-weekly': { title: '周报生成脚本', kind: 'dsh', project: 'weekly-report', device: '家里台式机', msgs: [
      s('DSH · 09:41', 'user', '按上周的数据出周报，格式和以前一样。'),
      s('DSH · 09:50', 'manager', '上周数据缺 11-18、11-19 两天。按 5 天出，还是等补齐？'),
      { kind: 'sys', text: '同步于 10:21 · 家里台式机在线' },
    ] },
  };
}
const genericDisc = sess => ({ title: sess.title, kind: sess.kind, project: sess.project, device: sess.device, msgs: [
  { kind: 'sys', text: `${KIND[sess.kind].label} · ${sess.project || '未归类'} · 最近：${sess.recent}` },
  { kind: 'gap', text: '原型只为「登录页改版」准备了完整内容' },
] });

let state;
function fresh() {
  return {
    screen: 'home', online: true, ready: true, dark: state ? state.dark : false,
    computers: { work: { name: '工作电脑', online: false, last: '昨天 23:10' }, home: { name: '家里台式机', online: true, last: '在线' } },
    home: [], discs: makeDiscs(), current: 'd-login', tasks: {}, sheet: null,
    tab: 'project', query: '', input: { home: '', disc: '' }, sugg: { home: [], disc: [] },
    weekly: null, conflict: false, decision: null, ctx: { disc: true, decision: true, excerpt: true },
    pendingSetup: null, toast: null, scrollBottom: true, flash: null,
  };
}

/* ================= 消息与流式 ================= */
const msgsOf = where => (where === 'home' ? state.home : state.discs[where].msgs);
function push(where, m) { m.id = m.id || id('m'); msgsOf(where).push(m); state.scrollBottom = true; return m; }
function userSay(where, text) {
  return push(where, { role: 'user', text, time: now(), draft: !state.online || !state.ready });
}
async function stream(where, text, extra = {}) {
  const m = push(where, { role: 'manager', text: '', time: now(), typing: true, ...extra });
  render();
  await sleep(380);
  m.typing = false; m.streaming = true; render();
  const node = () => document.querySelector(`[data-mid="${m.id}"] .bubble`);
  for (let i = 0; i < text.length; i += 2) {
    m.text = text.slice(0, i + 2);
    const el = node();
    if (el) { el.textContent = m.text; scrollStream(); }
    await sleep(16);
  }
  m.text = text; m.streaming = false; render();
  return m;
}
function scrollStream() { const s = $('.stream'); if (s) s.scrollTop = s.scrollHeight; }
function toast(text) {
  state.toast = text; render();
  const t = text; setTimeout(() => { if (state.toast === t) { state.toast = null; render(); } }, 2600);
}

/* ================= 意图（原型脚本） ================= */
async function sendFrom(where) {
  const key = where === 'home' ? 'home' : 'disc';
  const text = state.input[key].trim();
  if (!text) return;
  state.input[key] = '';
  state.sugg[key] = [];
  if (!state.ready) {
    userSay(where, text);
    state.pendingSetup = { where, text };
    state.sheet = { type: 'setup' };
    return render();
  }
  if (!state.online) {
    userSay(where, text);
    push(where, { kind: 'sys', text: '手机没有网络：这条已存为草稿，联网后由你点「发送」' });
    return render();
  }
  const m = userSay(where, text);
  render();
  await route(where, text, m);
}

async function route(where, text) {
  if (where === 'home') {
    if (/登录/.test(text) && /(接着|继续|昨天|上次|讨论)/.test(text)) return resumeLogin(text);
    if (/(接着|继续|那个|上次)/.test(text)) return ambiguous();
    if (/(查|搜)/.test(text)) return search('home');
    if (/(提纲|文案|起草|写)/.test(text)) return outline('home');
    return generic('home', text);
  }
  if (where !== 'd-login') return generic(where, text, true);
  if (/(改到|交给|电脑|去改|落到|执行)/.test(text)) return proposeHandoff();
  if (/(查|搜)/.test(text)) return search(where);
  if (/(短|文案|按钮)/.test(text)) return buttonDrafts();
  return generic(where, text);
}

async function generic(where, text, native) {
  const body = native
    ? '收到。这段话会存进围绕这个会话的讨论里，不会写入原会话。要让原会话接着做，说「交给电脑」，我会先给你看目标和权限。'
    : `好的。关于「${text.slice(0, 18)}${text.length > 18 ? '…' : ''}」，我先在手机上整理：\n· 目标和限制\n· 两个可选做法\n需要电脑执行时我再把它交过去。`;
  await stream(where, body);
}

async function resumeLogin(text) {
  await stream('home', '接上「登录页改版」（alcor-web · 工作电脑）。这是唯一匹配，直接打开。', { basis: '依据：讨论标题与昨天 21:40 的最近记录' });
  push('home', { kind: 'link', text: '已打开「登录页改版」· 打开和阅读不会发给电脑', to: 'd-login' });
  await sleep(500);
  state.current = 'd-login'; state.screen = 'disc';
  push('d-login', { kind: 'day', text: '今天 · 手机' });
  push('d-login', { role: 'user', text, time: now(), carried: true });
  render();
  await buttonDrafts();
}

async function ambiguous() {
  await stream('home', '最近有三件事都能叫“那个方案”。是哪一个？');
  push('home', { kind: 'choices', items: [
    { to: 'd-login', img: 'decision', title: '登录页改版', sub: '项目讨论 · alcor-web（工作电脑）· 昨天：按钮文案三个方案' },
    { to: 'd-pricing', img: 'decision', title: '定价页方案', sub: '项目讨论 · alcor-site（家里台式机）· 周一：年付折扣' },
    { to: 'c-api', img: 'exec-codex', title: '登录接口联调', sub: 'Codex 会话 · alcor-web（家里台式机）· 11-20：mock 401' },
  ] });
  render();
}

async function search(where) {
  if (!state.online) return;
  await stream(where, '查到的要点：主按钮文案通常 2–4 个汉字，动词开头更好理解；和流程中其他按钮保持同一种说法，比单纯缩短更重要。');
  push(where, { kind: 'search', at: now(), items: [
    { n: 1, title: '表单按钮文案指南', domain: 'design-guide.example' },
    { n: 2, title: '移动端主操作按钮的长度与可读性', domain: 'ux-notes.example' },
    { n: 3, title: '中文界面文案规范 · 按钮', domain: 'style.example' },
  ] });
  state.sugg[where === 'home' ? 'home' : 'disc'] = where === 'home' ? ['继续昨天的登录页讨论，按钮文案再短一点'] : ['按钮文案再短一点'];
  render();
}

async function outline(where) {
  await stream(where, '今天的提纲（草稿，可复制）：\n1. 回答 DSH：周报缺两天怎么出\n2. 定下登录页主按钮文案，交给工作电脑改\n3. 看定价页方案的年付折扣写法\n4. 晚上核对交出去的结果');
  push(where, { kind: 'sys', text: '已保存在当前对话 · 只在手机完成，没有发给电脑' });
  render();
}

async function buttonDrafts() {
  await stream('d-login', '依据昨天 21:40 的三个方案，再压短一些：', { basis: '依据：工作电脑 21:40 的记录（同步于 08:12）' });
  push('d-login', { kind: 'drafts', picked: null, items: [
    { text: '继续', why: '2 字 · 和注册流程一致（推荐）' },
    { text: '登录', why: '2 字 · 最直白' },
    { text: '进入', why: '2 字 · 偏中性，不强调动作' },
  ] });
  render();
}

function pickDraft(mid, i) {
  const m = msgsOf(state.current).find(x => x.id === mid);
  if (!m || m.picked != null) return;
  m.picked = i;
  const t = m.items[i].text;
  push(state.current, { role: 'user', text: `就用「${t}」`, time: now() });
  state.decision = t;
  push(state.current, { kind: 'decision', text: t });
  state.sugg.disc = ['把它改到登录页', '失败提示也改短吗？'];
  render();
}

async function proposeHandoff() {
  if (!state.decision) return stream('d-login', '文案还没定。先从上面的方案里选一个，再交给电脑？');
  await stream('d-login', '这是要交给电脑的内容。确认目标没错，再点「交给电脑」：');
  const t = newTask();
  push('d-login', { kind: 'handoff', task: t.id });
  render();
}

function newTask(extra = {}) {
  const t = {
    id: id('t'), req: `req-${Math.random().toString(16).slice(2, 6)}`, stage: 'draft',
    title: `登录页主按钮改为「${state.decision || '继续'}」`, device: 'work', project: 'alcor-web',
    exec: 'codex', target: '原会话「登录页重构」', bound: true,
    perms: '只改 src/pages/login/**；不提交、不推送', accept: `按钮显示「${state.decision || '继续'}」；构建和登录页测试通过`,
    materials: '决定 1 条 · 讨论摘录 2 段', log: [], diff: null, ...extra,
  };
  state.tasks[t.id] = t;
  return t;
}
const taskList = () => Object.values(state.tasks);
const mainTask = () => taskList().filter(t => t.stage !== 'draft').slice(-1)[0];
function log(t, text, kind = '') { t.log.push({ time: now(), text, kind }); }

/* ================= 交接与回执（右侧模拟证据驱动） ================= */
async function confirmTask(tid) {
  const t = state.tasks[tid];
  if (!t || t.stage !== 'draft') return;
  log(t, '你在手机上确认交给电脑（一次授权）');
  t.stage = 'local';
  log(t, '已保存在手机，尚未发送');
  render();
  if (state.computers[t.device].online && state.online) await deliver(t, 'ok');
  else toast(`已记下 · ${state.computers[t.device].name}离线，上线后核对再发`);
}

async function deliver(t, mode) {
  t.stage = 'sending';
  log(t, `${state.computers[t.device].name}在线：核对身份、授权、版本和有效期`);
  render();
  await sleep(900);
  if (t.stage !== 'sending') return;
  if (mode === 'lost') { t.stage = 'verify'; log(t, `已发出 ${t.req}，没有收到匹配回执`, 'warn'); }
  else { t.stage = 'queued'; log(t, `Hub 回执：已登记 ${t.req}，排队等待执行`); }
  render();
}

async function workOnline(mode) {
  state.computers.work.online = true;
  render();
  if (!state.online) return toast('手机还没联网：待发命令留在手机');
  for (const t of taskList()) if (t.device === 'work' && t.stage === 'local') await deliver(t, mode);
}

const EVIDENCE = {
  verifyFound: t => { t.stage = 'queued'; log(t, `核对：Hub 已有 ${t.req}，不重发`); },
  verifyMissing: async t => {
    log(t, `核对：Hub 与原生都没有 ${t.req}；按原请求补发`, 'warn'); render();
    await sleep(700); t.stage = 'queued'; log(t, `Hub 回执：已登记 ${t.req}`);
  },
  start: t => { t.stage = 'running'; log(t, `${EXEC[t.exec].label}${t.target}：回合 #15 开始`); },
  finish: t => {
    t.stage = 'review';
    t.diff = { file: 'src/pages/login/SubmitButton.tsx', del: '立即登录并进入工作台', add: state.decision || '继续' };
    log(t, '回合 #15 结束：改动 1 个文件，构建和登录页测试通过');
  },
  fail: t => { t.stage = 'failed'; t.reason = '登录页测试有 1 项断言仍是旧文案'; log(t, `回合 #15 失败：${t.reason}`, 'bad'); },
  replay: t => { toast(`重复的「回合开始」事件：按 ${t.req} 去重，没有新增消息`); return true; },
};
async function evidence(kind) {
  const t = mainTask();
  if (kind === 'online') return workOnline('ok');
  if (kind === 'onlineLost') return workOnline('lost');
  if (kind === 'offline') { state.computers.work.online = false; return render(); }
  if (!t) return;
  const skip = await EVIDENCE[kind](t);
  if (!skip) render();
}

function userAct(tid, act) {
  const t = state.tasks[tid];
  if (!t) return;
  if (act === 'cancel' && t.stage === 'local') { t.stage = 'cancelled'; log(t, '你撤销了这条待发命令；不会派发', 'bad'); toast('已撤销，不会派发'); }
  if (act === 'accept' && t.stage === 'review') {
    t.stage = 'done'; log(t, '你核对了改动，验收通过');
    push('d-login', { kind: 'sys', text: `结果已回到这里：${t.title} · 已完成` });
  }
  if (act === 'retry' && t.stage === 'failed') {
    const n = newTask({ accept: `${t.accept}；同步更新登录页测试的断言` });
    push('d-login', { role: 'manager', text: '失败原因是测试还在断言旧文案。我把“更新测试断言”加进验收条件，生成一条新命令，确认后再发：', time: now() });
    push('d-login', { kind: 'handoff', task: n.id });
    state.screen = 'disc'; state.current = 'd-login'; state.sheet = null;
  }
  render();
}

/* ================= 渲染 ================= */
function render() {
  const app = $('#app');
  const prev = $('.stream, .list');
  const keep = prev ? prev.scrollTop : 0;
  if (prev && prev.classList.contains('stream') && prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80) state.scrollBottom = true;
  document.body.classList.toggle('dark', state.dark);
  $('#sb-icons').innerHTML = (state.online ? ic('signal', 'sm') + ic('wifi', 'sm') : ic('wifioff', 'sm')) + ic('battery', 'sm');
  app.innerHTML = (state.screen === 'home' ? viewHome() : state.screen === 'sessions' ? viewSessions() : viewDisc()) + viewSheet() + (state.toast ? `<div class="toast" role="status">${esc(state.toast)}</div>` : '');
  const s = $('.stream, .list');
  if (s) s.scrollTop = state.scrollBottom && s.classList.contains('stream') ? s.scrollHeight : keep;
  state.scrollBottom = false;
  if (state.flash) { const el = $(state.flash); if (el) el.focus(); state.flash = null; }
  renderSide();
}

const onlineCount = () => Object.values(state.computers).filter(c => c.online).length;
function topStatus(compact) {
  const n = onlineCount();
  return `<button class="pill" data-act="sheet" data-v="devices" aria-label="电脑在线 ${n}/2">${ic('monitor', 'xs')}${compact ? '' : '电脑 '}${n}/2</button>`;
}
function banner() {
  if (!state.online) return `<div class="banner offline"><img src="${A('offline-phone')}" alt="" width="34" height="34"><div>手机没有网络。可以看记录、存草稿；新的回答和搜索要等联网。</div></div>`;
  return '';
}

function viewHome() {
  const sub = !state.ready ? '<span class="dot warn"></span>DeepSeek 未接入' : state.online ? '<span class="dot on"></span>DeepSeek · 手机直连' : '<span class="dot off"></span>手机离线';
  const agenda = homeAgenda();
  const welcome = state.home.length ? '' : `<div class="welcome"><img src="${A('avatar')}" alt=""><b>有什么要做的？</b>提新需求，或说“接着聊昨天那个方案”。</div>`;
  const setup = state.ready ? '' : `<div class="msg card"><div class="card-box"><div class="card-head"><img src="${A('phone-assistant')}" alt=""><div class="t"><b>先接入 DeepSeek，只需这一步</b><span>接入后手机就能对话、搜索和起草。配对电脑可以以后再说。</span></div></div><button class="btn primary" data-act="sheet" data-v="setup">接入 DeepSeek</button></div></div>`;
  return `
  <header class="topbar">
    <img class="avatar" src="${A('avatar')}" alt="">
    <div class="title"><h1>星引</h1><div class="sub">${sub}</div></div>
    ${topStatus()}
    <button class="icon-btn" data-act="go" data-v="sessions" aria-label="找会话">${ic('layers')}</button>
  </header>
  ${banner()}
  <div class="stream">
    ${welcome}${setup}
    ${agenda.length ? `<div class="agenda">${agenda.join('')}</div>` : ''}
    ${state.home.map(renderMsg).join('')}
  </div>
  ${composer('home', '说说要做的事，或“接着昨天那个…”')}`;
}

function homeAgenda() {
  const out = [];
  const item = (act, v, img, kicker, title, sub, warn) => `<button class="agenda-item" data-act="${act}" data-v="${v}"><img src="${A(img)}" alt=""><div class="t"><div class="kicker${warn ? ' warn' : ''}">${esc(kicker)}</div><b>${esc(title)}</b><span>${esc(sub)}</span></div>${ic('right', 'sm')}</button>`;
  if (state.conflict) out.push(item('sheet', 'conflict', 'decision', '需要你选一下', '一项决定在两处被改过', '登录页改版 · 按钮：「继续」/「下一步」', true));
  if (!state.weekly) out.push(item('sheet', 'question', 'exec-dsh', 'DSH 在等你回答', '上周数据缺两天，周报怎么出？', '周报生成脚本 · 家里台式机 · 09:50', true));
  for (const t of taskList()) {
    if (t.stage === 'draft' || t.stage === 'cancelled') continue;
    const st = STAGE[t.stage];
    const kicker = t.stage === 'done' ? '已完成 · 结果在原讨论' : t.stage === 'review' ? '待验收 · 结果回来了' : st.label;
    out.push(item('task', t.id, 'handoff', kicker, t.title, `${state.computers[t.device].name} · ${EXEC[t.exec].label}${t.target}`, ['verify', 'failed', 'review'].includes(t.stage)));
  }
  if (!state.home.some(m => m.kind === 'link')) out.push(item('open', 'd-login', 'decision', '继续上次讨论', '登录页改版', 'alcor-web · 工作电脑 · 昨天 21:40 · 按钮文案三个方案'));
  return out;
}

function viewDisc() {
  const d = state.discs[state.current];
  const k = KIND[d.kind];
  const native = d.kind === 'codex' || d.kind === 'dsh';
  const nCtx = Object.values(state.ctx).filter(Boolean).length;
  const ctxChip = state.current === 'd-login' ? `<button class="chip ctx" data-act="sheet" data-v="ctx">${ic('clip', 'xs')}本轮材料 ${nCtx}</button>` : '';
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="go" data-v="home" aria-label="回到总管">${ic('back')}</button>
    <div class="title"><h1>${esc(d.title)}</h1><div class="sub"><span class="tag ${k.tag}">${k.label}</span>${esc(d.project || '未归类')} · ${esc(d.device)}</div></div>
    ${topStatus(true)}
    <button class="icon-btn" data-act="sheet" data-v="linked" aria-label="关联与决定">${ic('more')}</button>
  </header>
  ${banner()}
  <div class="stream">${d.msgs.map(renderMsg).join('')}</div>
  ${composer('disc', native ? '围绕这个会话讨论（不写入原会话）' : '接着讨论，或说“把它改到登录页”', ctxChip)}`;
}

function composer(key, ph, lead = '') {
  const sugg = state.sugg[key].map(s => `<button class="chip" data-act="sugg" data-k="${key}" data-v="${esc(s)}">${esc(s)}</button>`).join('');
  const val = state.input[key];
  return `<div class="composer-wrap">
    ${lead || sugg ? `<div class="ctx-line">${lead}${sugg}</div>` : ''}
    <div class="composer">
      <button class="icon-btn" aria-label="添加材料" data-act="toast" data-v="原型：可从找会话或相册选材料，选中的才会交给模型">${ic('plus')}</button>
      <textarea id="input-${key}" rows="${val.length > 16 ? 2 : 1}" data-k="${key}" placeholder="${esc(ph)}" aria-label="消息">${esc(val)}</textarea>
      ${val.trim() ? `<button class="send" data-act="send" data-k="${key}" aria-label="发送">${ic('up')}</button>` : `<button class="icon-btn" aria-label="语音" data-act="toast" data-v="原型：语音输入">${ic('mic')}</button>`}
    </div></div>`;
}

function renderMsg(m) {
  switch (m.kind) {
    case 'day': return `<div class="day">${esc(m.text)}</div>`;
    case 'sys': return `<div class="sysline">${esc(m.text)}</div>`;
    case 'gap': return `<div class="sysline gap">${esc(m.text)}</div>`;
    case 'link': return `<button class="sysline" data-act="open" data-v="${m.to}" style="border:0">${esc(m.text)} ›</button>`;
    case 'choices': return `<div class="msg card"><div class="card-box">
      ${m.items.map(c => `<button class="choice" data-act="open" data-v="${c.to}"><img src="${A(c.img)}" alt=""><div class="t"><b>${esc(c.title)}</b><span>${esc(c.sub)}</span></div>${ic('right', 'sm')}</button>`).join('')}
      <button class="btn text" data-act="newdisc">都不是，开一场新讨论</button>
      <div class="foot-note">只是打开，不会向电脑发送任何东西。</div></div></div>`;
    case 'search': return `<div class="msg card"><div class="card-box">
      <div class="card-head"><img src="${A('search-source')}" alt=""><div class="t"><b>联网搜索 · ${m.items.length} 个来源</b><span>检索于 ${m.at} · DeepSeek 搜索（原型为示例来源）</span></div></div>
      <div class="src-list">${m.items.map(s => `<a class="src-item" href="#" data-act="toast" data-v="原型：在浏览器打开 ${s.domain}"><em>[${s.n}]</em><div>${esc(s.title)}<small>${esc(s.domain)}</small></div></a>`).join('')}</div></div></div>`;
    case 'drafts': return `<div class="msg card"><div class="card-box">
      <div class="card-head"><img src="${A('phone-assistant')}" alt=""><div class="t"><b>按钮文案 · 三个更短的</b><span>在手机完成 · 选定前不会改任何文件</span></div></div>
      ${m.items.map((d, i) => `<div class="draft${m.picked === i ? ' picked' : ''}"><div class="t"><q>${esc(d.text)}</q><small>${esc(d.why)}</small></div>
        <button class="icon-btn" aria-label="复制" data-act="copy" data-v="${esc(d.text)}">${ic('copy', 'sm')}</button>
        ${m.picked == null ? `<button class="btn ghost" data-act="pick" data-mid="${m.id}" data-i="${i}">用这个</button>` : m.picked === i ? `<span class="state st-review">${ic('check', 'xs')}已选</span>` : ''}</div>`).join('')}
    </div></div>`;
    case 'decision': return `<div class="msg card"><div class="decision"><img src="${A('decision')}" alt=""><div class="t">已记为这项工作的决定：按钮用「${esc(state.decision || m.text)}」<small>引用你的原话 · 适用于这次登录页改动 · 没有派工</small></div></div></div>`;
    case 'handoff': return renderTask(state.tasks[m.task]);
  }
  const who = m.role === 'user' ? 'user' : 'manager';
  let meta;
  if (m.synced) meta = `<span class="src">${esc(m.src)}</span>`;
  else if (who === 'user') meta = m.draft ? `草稿 · 未发送${state.online && state.ready ? ` <button class="btn text" style="min-height:0;padding:0 4px" data-act="senddraft" data-mid="${m.id}">发送</button>` : ''}` : `${m.carried ? '从总管带入 · ' : ''}${ic('check', 'xs')}已存手机 ${m.time}`;
  else meta = m.typing ? '' : `${m.basis ? esc(m.basis) + ' · ' : ''}${m.time}`;
  const body = m.typing ? '<span class="typing"><i></i><i></i><i></i></span>' : esc(m.text);
  return `<div class="msg ${who}${m.synced ? ' synced' : ''}" data-mid="${m.id}"><div class="bubble${m.streaming ? ' cursor' : ''}">${body}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>`;
}

function stateBadge(t) { const s = STAGE[t.stage]; return `<span class="state ${s.cls}"><span class="dot"></span>${s.label}</span>`; }
function steps(t) {
  const s = STAGE[t.stage];
  return `<div class="steps" aria-hidden="true">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= s.step ? (i === s.step && s.mark ? s.mark : 'on') : ''}"></i>`).join('')}</div>`;
}
function target(t) {
  const c = state.computers[t.device];
  return `<span class="pill"><span class="dot ${c.online ? 'on' : 'off'}"></span>${c.name}</span><span class="pill">${esc(t.project)}</span><br><span class="tag ${EXEC[t.exec].tag}">${EXEC[t.exec].label}</span>${esc(t.target)}`;
}

function renderTask(t) {
  if (!t) return '';
  if (t.stage === 'draft') return `<div class="msg card"><div class="card-box">
    <div class="card-head"><img src="${A('handoff')}" alt=""><div class="t"><b>${esc(t.title)}</b><span>确认后交给电脑 · ${t.req}</span></div></div>
    <dl class="kv"><dt>做什么</dt><dd>${esc(t.title)}</dd><dt>发往</dt><dd>${target(t)}</dd><dt>权限</dt><dd>${esc(t.perms)}</dd><dt>验收</dt><dd>${esc(t.accept)}</dd><dt>附带</dt><dd>${esc(t.materials)}</dd></dl>
    <div class="row-btns"><button class="btn primary grow" data-act="confirm" data-v="${t.id}">交给电脑</button><button class="btn ghost" data-act="sheet" data-v="target" data-t="${t.id}">改目标</button><button class="btn text" data-act="dismiss" data-v="${t.id}">先不发</button></div>
    <div class="foot-note">点「交给电脑」即对这个目标授权一次。「接着聊」、看进度、认可文案都不算开工。</div></div></div>`;
  const last = t.log[t.log.length - 1];
  const c = state.computers[t.device];
  const offlineNote = t.stage === 'running' && !c.online ? '（电脑已离线，以上是最后回执）' : '';
  const extra = {
    local: `<div class="evidence"><img src="${A('computer-asleep')}" alt="">${c.online ? '电脑在线，手机联网后核对再发。' : `${c.name}离线（最后在线 ${c.last}）。上线后核对身份、授权、版本和有效期仍相符才发送。`}</div>
      <div class="row-btns"><button class="btn ghost" data-act="sheet" data-v="target" data-t="${t.id}">${ic('edit', 'sm')}修改</button><button class="btn danger" data-act="task-cancel" data-v="${t.id}">${ic('undo', 'sm')}撤销</button></div>`,
    verify: `<div class="evidence">先按原请求 ${t.req} 查 Hub 和原生记录；核对前不新建请求重发，也不显示执行中。</div>`,
    review: t.diff ? `<div class="diff"><span>${esc(t.diff.file)}</span>\n<span class="del">- ${esc(t.diff.del)}</span>\n<span class="add">+ ${esc(t.diff.add)}</span></div>
      <div class="row-btns"><button class="btn primary grow" data-act="task-accept" data-v="${t.id}">核对无误，验收</button><button class="btn ghost" data-act="toast" data-v="原型：打开 Codex 原会话「登录页重构」回合 #15">原会话</button></div>` : '',
    failed: `<div class="question">失败原因：${esc(t.reason)}<div class="row-btns"><button class="btn primary" data-act="task-retry" data-v="${t.id}">改验收条件后重发</button></div></div>`,
    done: `<div class="row-btns"><button class="btn ghost" data-act="toast" data-v="原型：打开改动 ${t.diff ? t.diff.file : ''}">${ic('file', 'sm')}查看改动</button><button class="btn ghost" data-act="toast" data-v="原型：打开 Codex 原会话「登录页重构」">${ic('ext', 'sm')}原会话</button></div>`,
  }[t.stage] || '';
  return `<div class="msg card"><div class="card-box">
    <div class="card-head"><img src="${A('handoff')}" alt=""><div class="t"><b>${esc(t.title)}</b><span>${c.name} · ${EXEC[t.exec].label}${esc(t.target)}</span></div></div>
    <div>${stateBadge(t)}</div>${steps(t)}
    <div class="evidence"><img src="${A('receipt')}" alt=""><div>${esc(last.text)}${offlineNote} · ${last.time}</div></div>
    ${extra}
    <button class="btn text" data-act="task" data-v="${t.id}" style="align-self:flex-start">全部回执 ›</button></div></div>`;
}

function viewSessions() {
  const q = state.query.trim();
  const list = SESSIONS.filter(s => !q || (s.title + (s.project || '') + s.recent).includes(q));
  const row = s => `<button class="s-row" data-act="open" data-v="${s.id}"><img src="${A(KIND[s.kind].img)}" alt=""><div class="t"><b>${esc(s.title)}</b><span><span class="tag ${KIND[s.kind].tag}">${KIND[s.kind].label}</span>${s.gap ? '<span class="tag gap">有缺口</span>' : ''}${esc(s.recent)}</span></div><time>${esc(s.time)}</time></button>`;
  const group = (h, items, aside = '') => items.length ? `<div class="group-h"><span>${esc(h)}</span><span>${esc(aside)}</span></div><div class="s-group">${items.map(row).join('')}</div>` : '';
  let body = '';
  if (state.tab === 'project') {
    const keys = [];
    list.forEach(s => { const k = s.project ? `${s.project} · ${s.device}` : '未归类'; if (!keys.includes(k)) keys.push(k); });
    keys.sort((a, b) => (a === '未归类') - (b === '未归类'));
    body = keys.map(k => group(k, list.filter(s => (s.project ? `${s.project} · ${s.device}` : '未归类') === k), k.startsWith('alcor-web') ? '同名项目按设备分开' : '')).join('');
  } else if (state.tab === 'recent') {
    body = group('按你最后使用排序', [...list].sort((a, b) => b.used - a.used), '重新同步不改顺序');
  } else {
    body = Object.keys(KIND).map(k => group(KIND[k].label, list.filter(s => s.kind === k))).join('');
  }
  if (!list.length) body = `<div class="empty"><img src="${A('find-sessions')}" alt="">没有找到“${esc(q)}”。<br>只搜索已同步的标题和摘录。</div>`;
  const tab = (v, l) => `<button role="tab" aria-selected="${state.tab === v}" data-act="tab" data-v="${v}">${l}</button>`;
  return `
  <header class="topbar">
    <button class="icon-btn" data-act="go" data-v="home" aria-label="回到总管">${ic('back')}</button>
    <div class="title"><h1>找会话</h1><div class="sub">和总管用同一份索引 · 同步于 10:21</div></div>
    ${topStatus()}
  </header>
  <label class="search-field">${ic('search', 'sm')}<input id="sess-q" placeholder="搜标题、项目或最近主题" value="${esc(state.query)}"></label>
  <div class="tabs" role="tablist">${tab('project', '项目')}${tab('recent', '最近')}${tab('kind', '分类')}</div>
  <div class="list">${body}</div>`;
}

/* ================= 弹层 ================= */
function viewSheet() {
  const sh = state.sheet;
  if (!sh) return '';
  const wrap = (inner, label) => `<div class="scrim" data-act="close"></div><section class="sheet" role="dialog" aria-label="${esc(label)}"><div class="grab"></div>${inner}</section>`;
  if (sh.type === 'setup') return wrap(`
    <h2>接入 DeepSeek</h2><p class="lead">只需这一步。接入后手机直连 DeepSeek，电脑全关也能对话、搜索和起草。配对电脑可以以后再说。</p>
    <label class="field">API Key<input id="key-input" type="password" autocomplete="off" placeholder="粘贴你的 DeepSeek API Key"></label>
    <div class="foot-note" style="margin-top:8px">${ic('shield', 'xs')} 保存在 Android 系统密钥库，只用于手机直连，不经过任何电脑，也不会出现在日志里。原型不保存输入。</div>
    <div class="row-btns" style="margin-top:14px"><button class="btn primary grow" data-act="setup-save" id="setup-save" disabled>保存并开始</button></div>`, '接入 DeepSeek');
  if (sh.type === 'devices') {
    const dev = (k, conn) => { const c = state.computers[k]; const pend = taskList().filter(t => t.device === k && t.stage === 'local').length;
      return `<div class="dev"><img src="${A(c.online ? 'handoff' : 'computer-asleep')}" alt="" width="34" height="34"><div class="t"><b>${c.name}</b><span><span class="dot ${c.online ? 'on' : 'off'}"></span> ${c.online ? '在线' : `离线 · 最后在线 ${c.last}`}${pend ? ` · 待发 ${pend}` : ''}</span><span>${conn}</span></div></div>`; };
    return wrap(`<h2>电脑</h2><p class="lead">平时不用来这里。需要电脑时，总管会在对话里告诉你在等哪台。</p>
      <div class="section">${dev('work', 'Codex 原会话 ✓ · DSH 托管 ✓')}${dev('home', 'Codex ✓ · DSH 原 Host ✓（不支持按回合停止）')}</div>
      <div class="section"><h3>手机侧</h3><div class="dev"><img src="${A('phone-assistant')}" alt="" width="34" height="34"><div class="t"><b>手机助手</b><span>${state.ready ? 'DeepSeek 直连 · 搜索可用' : 'DeepSeek 未接入'}${state.online ? '' : ' · 当前无网络'}</span></div></div></div>
      <button class="btn ghost" style="width:100%" data-act="toast" data-v="原型：扫码配对新电脑">${ic('plus', 'sm')}配对一台电脑</button>`, '电脑');
  }
  if (sh.type === 'ctx') {
    const row = (k, t, s) => `<label class="toggle-row"><div class="t">${t}<small>${s}</small></div><input type="checkbox" data-act="ctx" data-v="${k}" ${state.ctx[k] ? 'checked' : ''}></label>`;
    return wrap(`<h2>本轮交给模型的材料</h2><p class="lead">只取这一轮需要的。取消勾选就不会发给 DeepSeek。</p>
      ${row('disc', '登录页改版 · 最近 12 条', '手机与电脑合并后的讨论')}
      ${row('decision', '决定：按钮用「继续」', state.decision ? '你今天选定的' : '尚未选定，暂无内容')}
      ${row('excerpt', 'Codex「登录页重构」摘录 2 段', '同步于 08:12 · 20:30–20:58 有缺口')}
      <div class="row-btns" style="margin-top:12px"><button class="btn primary grow" data-act="close">好</button></div>`, '本轮材料');
  }
  if (sh.type === 'target') {
    const t = state.tasks[sh.t];
    const opt = (v, img, title, sub, dis) => `<button class="choice" ${dis ? 'disabled style="opacity:.5;cursor:not-allowed"' : `data-act="pick-target" data-v="${v}" data-t="${t.id}"`}><img src="${A(img)}" alt=""><div class="t"><b>${title}</b><span>${sub}</span></div>${!dis && ((v === 'orig' && t.bound) || (v === 'dsh' && t.exec === 'dsh' && !t.bound) || (v === 'codex-new' && t.exec === 'codex' && !t.bound)) ? ic('check', 'sm') : ''}</button>`;
    return wrap(`<h2>发往哪里</h2><p class="lead">继续已有工作默认交回原会话；目标不兼容或离线时只说明原因，不偷偷换会话。</p>
      <div class="section">
      ${opt('orig', 'exec-codex', 'Codex 原会话「登录页重构」', '工作电脑 · 已绑定这场讨论（推荐）')}
      ${opt('dsh', 'exec-dsh', '新建 DSH 托管工作', '工作电脑 · alcor-web · 桌面默认执行端')}
      ${opt('codex-new', 'exec-codex', '新建 Codex 工作', '工作电脑 · alcor-web')}
      ${opt('x', 'find-sessions', 'alcor-web（家里台式机）', '同名但不是同一个项目，不能自动选择', true)}</div>`, '发往哪里');
  }
  if (sh.type === 'task') {
    const t = state.tasks[sh.t];
    return wrap(`<h2>${esc(t.title)}</h2><p class="lead">${stateBadge(t)}　请求 ${t.req}</p>
      <dl class="kv"><dt>发往</dt><dd>${target(t)}</dd><dt>权限</dt><dd>${esc(t.perms)}</dd><dt>验收</dt><dd>${esc(t.accept)}</dd></dl>
      <div class="section"><h3>回执（只按收到的证据记录）</h3><ul class="timeline">${t.log.map(l => `<li class="${l.kind}">${esc(l.text)}<small>${l.time}</small></li>`).join('')}${['done', 'cancelled', 'failed'].includes(t.stage) ? '' : `<li class="pending">下一步：${{ local: '等电脑上线', sending: '等 Hub 回执', queued: '等原执行端开始', verify: '核对原请求', running: '等回合结束', review: '等你验收' }[t.stage]}<small>未发生</small></li>`}</ul></div>
      <div class="row-btns"><button class="btn ghost grow" data-act="open" data-v="d-login">回到原讨论</button>${t.stage === 'review' ? `<button class="btn primary grow" data-act="task-accept" data-v="${t.id}">验收</button>` : ''}${t.stage === 'failed' ? `<button class="btn primary grow" data-act="task-retry" data-v="${t.id}">改后重发</button>` : ''}</div>`, '任务详情');
  }
  if (sh.type === 'question') {
    const home = state.computers.home.online;
    return wrap(`<h2>DSH 在等你回答</h2><p class="lead">周报生成脚本 · weekly-report · 家里台式机${home ? '在线' : '离线'}</p>
      <div class="question">上周数据缺 11-18、11-19 两天。按 5 天出，还是等补齐？</div>
      <div class="section"><button class="choice" data-act="answer" data-v="按 5 天出，注明缺两天"><div class="t"><b>按 5 天出，注明缺两天</b></div></button><button class="choice" data-act="answer" data-v="等补齐再出"><div class="t"><b>等补齐再出</b></div></button></div>
      <button class="btn text" data-act="open" data-v="h-weekly">打开原会话看上下文 ›</button>`, 'DSH 提问');
  }
  if (sh.type === 'conflict') return wrap(`<h2>这项决定在两处被改过</h2><p class="lead">登录页改版 · 主按钮文案。只需选这一项，其他内容都已合并。</p>
    <div class="conflict">
      <button class="choice" data-act="resolve" data-v="继续"><img src="${A('phone-assistant')}" alt=""><div class="t"><b><q>继续</q></b><span>手机 · 今天 10:20 · 你说「就用继续」</span></div></button>
      <button class="choice" data-act="resolve" data-v="下一步"><img src="${A('exec-codex')}" alt=""><div class="t"><b><q>下一步</q></b><span>工作电脑 · 今天 10:31 · 你在桌面讨论里改的</span></div></button>
    </div>
    <div class="foot-note" style="margin-top:10px">没选之前，交给电脑的命令不会带这项决定。未选的版本保留在历史里。</div>`, '决定冲突');
  if (sh.type === 'linked') return wrap(`<h2>这场讨论关联的</h2>
    <div class="section"><h3>原生会话</h3><button class="choice" data-act="open" data-v="c-login"><img src="${A('exec-codex')}" alt=""><div class="t"><b>Codex「登录页重构」</b><span>工作电脑 · alcor-web · 原 owner：Codex 桌面</span></div>${ic('right', 'sm')}</button></div>
    <div class="section"><h3>决定</h3>${state.decision ? `<div class="decision"><img src="${A('decision')}" alt=""><div class="t">按钮用「${esc(state.decision)}」<small>适用于这次改动 · 未写入项目规则</small></div></div>` : '<div class="foot-note">还没有记下的决定。</div>'}</div>
    <div class="section"><h3>交给电脑的</h3>${taskList().filter(t => t.stage !== 'draft').map(t => `<button class="choice" data-act="task" data-v="${t.id}"><img src="${A('handoff')}" alt=""><div class="t"><b>${esc(t.title)}</b><span>${STAGE[t.stage].label}</span></div></button>`).join('') || '<div class="foot-note">还没有。</div>'}</div>`, '关联');
  return '';
}

/* ================= 场景 ================= */
const GOALS = { 1: '打开手机就能说事', 2: '电脑全关也有独立价值', 3: '需要电脑时总管衔接', 4: '回应要快，状态要真' };
function withDecision() {
  const d = 'd-login';
  push(d, { kind: 'day', text: '今天 · 手机' });
  push(d, { role: 'user', text: '继续昨天的登录页讨论，按钮文案再短一点', time: '10:20', carried: true });
  push(d, { role: 'manager', text: '依据昨天 21:40 的三个方案，再压短一些：', time: '10:20', basis: '依据：工作电脑 21:40 的记录（同步于 08:12）' });
  push(d, { kind: 'drafts', picked: 0, items: [{ text: '继续', why: '2 字 · 和注册流程一致（推荐）' }, { text: '登录', why: '2 字 · 最直白' }, { text: '进入', why: '2 字 · 偏中性' }] });
  push(d, { role: 'user', text: '就用「继续」', time: '10:21' });
  state.decision = '继续';
  push(d, { kind: 'decision', text: '继续' });
}
function withTask() {
  withDecision();
  push('d-login', { role: 'user', text: '把它改到登录页', time: '10:22' });
  push('d-login', { role: 'manager', text: '这是要交给电脑的内容。确认目标没错，再点「交给电脑」：', time: '10:22' });
  const t = newTask();
  push('d-login', { kind: 'handoff', task: t.id });
  t.log.push({ time: '10:23', text: '你在手机上确认交给电脑（一次授权）', kind: '' }, { time: '10:23', text: '已保存在手机，尚未发送', kind: '' });
  t.stage = 'local';
}
const allOff = () => { state.computers.work.online = false; state.computers.home.online = false; state.computers.home.last = '今天 07:55'; };

const SCENARIOS = [
  { id: 's1', goal: 1, title: '打开就能说事', sub: '首屏即对话，事项就地打开', setup() {},
    note: ['首屏就是总管对话，输入框直接可用；不先让人选项目、工具或设备。', '「继续上次讨论」和「DSH 在等你回答」就地可点；没有事项时只显示一句提示，不摆空面板。', '右上「电脑 1/2」只是状态；工作电脑离线不阻断手机助手。'], tryIt: '点「DSH 在等你回答」直接回答；或点右上角看电脑。' },
  { id: 's2', goal: 1, title: '首次使用只补一步', sub: '缺 DeepSeek 配置时', setup() { state.ready = false; state.input.home = '帮我把今天要做的事列个提纲'; },
    note: ['首次缺 DeepSeek 配置时只引导这一步；不要求先配对电脑。', '已输入的话不会丢：保存配置后自动接着发出。', 'Key 只进系统密钥库，原型不保存任何输入。'], tryIt: '点发送，在弹层里随便输入几个字后保存。' },
  { id: 's3', goal: 1, title: '一句话接上昨天的讨论', sub: '唯一匹配直接打开', setup() { allOff(); state.input.home = '继续昨天的登录页讨论，按钮文案再短一点'; },
    note: ['唯一可靠匹配时直接打开原讨论，并说明依据哪条记录、同步于何时。', '这句话被带进讨论，DeepSeek 在手机上直接回答；电脑全关不影响。', '同步缺口用琥珀色标出，不凭标题补写正文。打开和阅读不会发给电脑。'], tryIt: '点发送，再在文案里点「用这个」。' },
  { id: 's4', goal: 1, title: '说法有歧义', sub: '只给少量候选', setup() { state.input.home = '接着聊那个方案'; },
    note: ['有歧义时只给 3 个候选，标明来源类型、项目、所在电脑和最近主题。', '同名项目 alcor-web 在两台电脑上，靠设备区分，不按标题合并。', '取消或选择都不会向电脑发送任何东西。'], tryIt: '点发送，选「登录页改版」。' },
  { id: 's8', goal: 1, title: '自己找会话', sub: '项目 / 最近 / 分类', setup() { state.screen = 'sessions'; },
    note: ['和总管共用同一份索引：总管能找到的，这里也能找到同一条。', '分类区分总管对话、项目讨论、Codex、DSH 原生会话，保留未归类。', '「最近」按用户使用排序，重新同步不会把老会话顶上来；低置信的目录推断只作提示。'], tryIt: '切换三个标签；搜索“登录”。' },
  { id: 's5', goal: 2, title: '电脑全关也能办事', sub: '搜索 · 起草 · 记下决定', setup() { allOff(); state.input.home = '查一下登录按钮文案一般多长合适'; },
    note: ['所有电脑离线，手机 DeepSeek 照常对话和联网搜索。', '搜索结果标明来源与检索时间（原型使用示例域名，不是真实引用）。', '起草的文本可复制、可存进讨论；选定的文案记为这项工作的决定，但不派工。'], tryIt: '发送后点建议「继续昨天的登录页讨论…」。' },
  { id: 's9', goal: 2, title: '手机也断网', sub: '看记录、存草稿', setup() { state.online = false; state.screen = 'disc'; state.input.disc = '按钮文案再短一点'; },
    note: ['没有网络时仍能浏览本地记录、保存草稿。', '不显示新的模型回答或搜索结果，也不假装在处理。', '联网后草稿保留，由用户点「发送」才交给模型。'], tryIt: '发送一条，再在右侧打开「手机网络」，点草稿旁的「发送」。' },
  { id: 's6', goal: 3, title: '从讨论转为执行', sub: '看清目标后一次授权', setup() { allOff(); state.screen = 'disc'; withDecision(); state.input.disc = '把它改到登录页'; },
    note: ['在原对话里给出交接卡：做什么、发往哪台电脑哪个项目、原会话或新建、权限和验收。', '继续已有工作默认交回绑定的 Codex 原会话；同名项目不能自动选。', '明确点「交给电脑」才算授权；电脑离线时显示「已记下，等电脑上线」，可修改或撤销。'], tryIt: '发送，点「改目标」看看，再点「交给电脑」。' },
  { id: 's7', goal: 4, title: '等待如实显示', sub: '用右侧模拟回执推进', setup() { state.screen = 'disc'; withTask(); },
    note: ['只有手机证据：已记下；Hub 回执：电脑已收到；原生开始：执行中；结果回来：待验收；你核对后：已完成。', '回执丢失显示「送达待核对」，只按原请求核对，不新建请求重发。', '重放的旧事件按请求 ID 去重，不出第二条消息。回到总管首屏能看到这件事在等谁。'], tryIt: '右侧依次点「工作电脑上线」「原生回合开始」「回合结束」，最后在卡片里验收。' },
  { id: 's10', goal: 4, title: '决定在两处被改', sub: '只选冲突的那一项', setup() { withDecision(); state.conflict = true; },
    note: ['同一决定在手机和电脑都被改过时，两版都保留，只请用户选这一项。', '其他消息按来源与消息 ID 合并，不按最后写入覆盖整段历史。', '未选之前，交给电脑的命令不带这项决定。'], tryIt: '点首屏「一项决定在两处被改过」。' },
];
let current = 's1';

function runScenario(sid) {
  gen++; uid = 0; minute = 10 * 60 + 24; ticks = 0;
  state = fresh();
  current = sid;
  SCENARIOS.find(s => s.id === sid).setup();
  state.scrollBottom = true;
  state.flash = state.screen === 'sessions' ? null : `#input-${state.screen === 'home' ? 'home' : 'disc'}`;
  render();
  document.querySelector('.guide').classList.remove('open');
}

/* ================= 外侧面板 ================= */
function renderSide() {
  $('#scenarios').innerHTML = [1, 2, 3, 4].map(g => `<div class="sc-group"><h2>目标 ${g} · ${GOALS[g]}</h2>${SCENARIOS.filter(s => s.goal === g).map(s => `<button class="sc-btn" data-sc="${s.id}" aria-current="${s.id === current}">${s.title}<small>${s.sub}</small></button>`).join('')}</div>`).join('');
  const sc = SCENARIOS.find(s => s.id === current);
  $('#note').innerHTML = `<span class="goal">体验目标 ${sc.goal} · ${GOALS[sc.goal]}</span><h2>${sc.title}</h2><ul>${sc.note.map(n => `<li>${esc(n)}</li>`).join('')}</ul><p style="margin:8px 0 0"><b>试试：</b>${esc(sc.tryIt)}</p>`;
  $('#ctl-net').checked = state.online;
  $('#ctl-work').checked = state.computers.work.online;
  $('#ctl-dark').checked = state.dark;
  const t = mainTask();
  const st = t ? t.stage : null;
  const off = !state.computers.work.online;
  const b = (k, l, ok) => `<button data-ev="${k}" ${ok ? '' : 'disabled'}>${l}</button>`;
  $('#evidence').innerHTML = `<h2>模拟证据 <small>代替电脑与执行端</small></h2>
    <p class="ev-hint">${t ? `当前：${STAGE[st].label} · ${t.req}` : '先在讨论里把工作「交给电脑」。'}</p>
    <div class="ev-btns">
      ${b('online', '工作电脑上线', off)}${b('onlineLost', '上线但回执丢失', off && st === 'local')}${b('offline', '工作电脑下线', !off)}
      ${b('verifyFound', '核对：Hub 有此请求', st === 'verify')}${b('verifyMissing', '核对：Hub 没有', st === 'verify')}
      ${b('start', '原生回合开始', st === 'queued')}${b('finish', '回合结束', st === 'running')}${b('fail', '回合失败', st === 'running')}
      ${b('replay', '重放旧事件', ['running', 'review', 'done'].includes(st))}
    </div>`;
  if (!$('#special-icons').childElementCount) {
    $('#special-icons').innerHTML = ['avatar', 'phone-assistant', 'exec-codex', 'exec-dsh', 'handoff', 'decision', 'receipt', 'search-source', 'computer-asleep', 'offline-phone', 'find-sessions']
      .map(n => `<img src="${A(n)}" alt="${n}" title="${n}">`).join('');
  }
}

/* ================= 事件 ================= */
document.addEventListener('click', e => {
  const sc = e.target.closest('[data-sc]');
  if (sc) return runScenario(sc.dataset.sc);
  const ev = e.target.closest('[data-ev]');
  if (ev) return quiet(evidence(ev.dataset.ev));
  const el = e.target.closest('[data-act]');
  if (!el || !$('#device').contains(el) && !el.closest('.notes')) return;
  if (el.tagName === 'INPUT') return;
  e.preventDefault();
  const { act, v } = el.dataset;
  const close = () => { state.sheet = null; };
  switch (act) {
    case 'go': state.screen = v; close(); state.scrollBottom = true; return render();
    case 'open':
      close();
      if (!state.discs[v]) state.discs[v] = genericDisc(SESSIONS.find(s => s.id === v) || { title: v, kind: 'disc', recent: '' });
      state.current = v; state.screen = 'disc'; state.scrollBottom = true; return render();
    case 'sheet': state.sheet = { type: v, t: el.dataset.t }; return render();
    case 'close': close(); return render();
    case 'tab': state.tab = v; return render();
    case 'send': return quiet(sendFrom(el.dataset.k === 'home' ? 'home' : state.current));
    case 'sugg': state.input[el.dataset.k] = v; return quiet(sendFrom(el.dataset.k === 'home' ? 'home' : state.current));
    case 'pick': return pickDraft(el.dataset.mid, +el.dataset.i);
    case 'copy': return toast(`已复制「${v}」`);
    case 'toast': return toast(v);
    case 'confirm': return quiet(confirmTask(v));
    case 'dismiss': { const t = state.tasks[v]; t.stage = 'cancelled'; t.log.push({ time: now(), text: '你选择先不发', kind: 'bad' });
      msgsOf(state.current).forEach(m => { if (m.task === v) { m.kind = 'sys'; m.text = '交接卡已收起，没有发给电脑'; } }); return render(); }
    case 'task': state.sheet = { type: 'task', t: v }; return render();
    case 'task-cancel': return userAct(v, 'cancel');
    case 'task-accept': close(); return userAct(v, 'accept');
    case 'task-retry': return userAct(v, 'retry');
    case 'pick-target': {
      const t = state.tasks[el.dataset.t];
      Object.assign(t, v === 'orig' ? { exec: 'codex', target: '原会话「登录页重构」', bound: true } : v === 'dsh' ? { exec: 'dsh', target: '新建托管工作', bound: false } : { exec: 'codex', target: '新建工作', bound: false });
      if (t.stage !== 'draft') t.log.push({ time: now(), text: `你把目标改为 ${EXEC[t.exec].label}${t.target}（仍未发送）`, kind: '' });
      close(); return render();
    }
    case 'newdisc': return quiet(stream('home', '好，直接说说新的方案，我在总管里开一场新讨论。'));
    case 'setup-save': {
      state.ready = true; close();
      const p = state.pendingSetup; state.pendingSetup = null;
      toast('已保存到系统密钥库');
      if (p) { const m = msgsOf(p.where).filter(x => x.role === 'user').slice(-1)[0]; if (m) m.draft = false; render(); return quiet(route(p.where, p.text)); }
      return render();
    }
    case 'senddraft': {
      const m = msgsOf(state.screen === 'home' ? 'home' : state.current).find(x => x.id === el.dataset.mid);
      if (!m) return; m.draft = false; m.time = now(); render();
      return quiet(route(state.screen === 'home' ? 'home' : state.current, m.text));
    }
    case 'answer': {
      const on = state.computers.home.online; close();
      state.weekly = v;
      push('home', { role: 'user', text: `回复 DSH「周报生成脚本」：${v}`, time: now() });
      push('home', { kind: 'sys', text: on ? `家里台式机 Hub 已收到 ${now()} · 原 Host 开始前不显示执行中` : '已记下，等家里台式机上线后核对再发' });
      return render();
    }
    case 'resolve': close(); state.conflict = false; state.decision = v; return toast(`已采用「${v}」，另一版保留在历史中`);
  }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.id === 'ctl-net') {
    state.online = t.checked;
    const where = state.screen === 'home' ? 'home' : state.current;
    if (t.checked && msgsOf(where).some(m => m.draft)) push(where, { kind: 'sys', text: '已联网 · 草稿仍在，点「发送」才交给模型' });
    if (t.checked && state.computers.work.online) quiet(workOnline('ok'));
    return render();
  }
  if (t.id === 'ctl-work') return t.checked ? quiet(workOnline('ok')) : (state.computers.work.online = false, render());
  if (t.id === 'ctl-dark') { state.dark = t.checked; return render(); }
  if (t.dataset.act === 'ctx') { state.ctx[t.dataset.v] = t.checked; return render(); }
});

document.addEventListener('input', e => {
  const t = e.target;
  if (t.matches('textarea[data-k]')) {
    const had = !!state.input[t.dataset.k].trim();
    state.input[t.dataset.k] = t.value;
    t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 120)}px`;
    if (had !== !!t.value.trim()) { state.flash = `#${t.id}`; render(); const n = $(`#${t.id}`); n.setSelectionRange(n.value.length, n.value.length); }
  }
  if (t.id === 'sess-q') { state.query = t.value; state.flash = '#sess-q'; render(); const n = $('#sess-q'); n.setSelectionRange(n.value.length, n.value.length); }
  if (t.id === 'key-input') $('#setup-save').disabled = !t.value.trim();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches('textarea[data-k]')) {
    e.preventDefault();
    quiet(sendFrom(e.target.dataset.k === 'home' ? 'home' : state.current));
  }
  if (e.key === 'Escape' && state.sheet) { state.sheet = null; render(); }
});

$('#guide-fab').addEventListener('click', () => document.querySelector('.guide').classList.toggle('open'));

runScenario(new URLSearchParams(location.search).get('s') || 's1');
