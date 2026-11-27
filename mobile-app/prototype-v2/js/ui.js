/* 通用界面积木和对话里的基础卡片。各屏在 screens-*.js 里向这四张表登记。 */
'use strict';
const SCREENS = {}, SHEETS = {}, ACT = {}, CARDS = {};

const badge = (label, t, dot = true) => `<span class="st tone-${t}">${dot ? '<i class="dot"></i>' : ''}${esc(label)}</span>`;
const stageBadge = t => badge(STAGE[t.stage].label, STAGE[t.stage].tone);
const tg = (on, act, arg, label, dis = false) => `<button class="tg${on ? ' on' : ''}" role="switch" aria-label="${esc(label)}" aria-checked="${!!on}" data-act="${act}" data-arg="${arg}" ${dis ? 'disabled' : ''}></button>`;
const seg = (items, curKey, act) => `<div class="seg">${items.map(([k, label]) => `<button class="${k === curKey ? 'on' : ''}" data-act="${act}" data-arg="${k}">${label}</button>`).join('')}</div>`;
const em = (name, size = 44) => `<img class="em" src="${A(name)}" width="${size}" height="${size}" alt="">`;
const tile = (icon, t = '') => `<span class="tile ${t ? 'tone-' + t : ''}">${ic(icon)}</span>`;
const box = (html, t = '', icon = 'info') => `<div class="box ${t ? 'tone-' + t : ''}">${ic(icon, 'xs')}<div>${html}</div></div>`;
/* 页面头部只放一个图标，不配介绍段落。 */
const hero = (name, size = 72) => `<div class="p-hero">${em(name, size)}</div>`;
/* 图标格子：并列的操作用图标加两三个字的标签，不配说明。 */
const tl = ({ img, icon, tone = '', label, act, arg = '' }) => `<button class="tl" data-act="${act}" data-arg="${arg}">${img ? em(img, 48) : tile(icon, tone)}<b>${label}</b></button>`;
const tiles = (items, cols = 4) => `<div class="tiles c${cols}">${items.filter(Boolean).map(tl).join('')}</div>`;

/* 列表行。title、sub、right 传入的是已转义的 HTML。带开关的行不要给 act（按钮不能套按钮）。 */
function row({ icon, img, tone = '', title, sub = '', right = '', act = '', arg = '', chev = true, cls = '' }) {
  const lead = img ? em(img, 36) : icon ? tile(icon, tone) : '';
  const el = act ? 'button' : 'div';
  return `<${el} class="row ${lead ? '' : 'noic'} ${cls}" ${act ? `data-act="${act}" data-arg="${arg}"` : ''}>${lead}<span class="row-t"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</span>${right ? `<span class="row-r">${right}</span>` : ''}${act && chev ? ic('right', 'chev') : ''}</${el}>`;
}
const group = rows => `<div class="group">${rows.filter(Boolean).join('')}</div>`;
const sec = (title, right = '') => `<div class="sec"><span>${title}</span>${right}</div>`;

function page({ title, sub = '', left = 'back', right = '', head = '', body, dock = '', cls = '', key = '' }) {
  const l = left === 'back' ? `<button class="ib" data-act="back" aria-label="返回">${ic('back')}</button>`
    : left === 'close' ? `<button class="ib" data-act="back" aria-label="关闭">${ic('x')}</button>` : left;
  return `<div class="page ${cls} ${S.enter}"><div class="bar">${l}<div class="ttl"><b>${title}</b>${sub ? `<small>${sub}</small>` : ''}</div>${right}</div>${head}<div class="scroll" data-scroll="${key || cur().n}">${body}</div>${dock}</div>`;
}
function sheet(title, body, { sub = '', foot = '', full = false, cls = '' } = {}) {
  return `<div class="sheet ${full ? 'full' : ''} ${cls}" role="dialog"><i class="grab"></i><div class="sheet-h"><b>${title}${sub ? `<small>${sub}</small>` : ''}</b><button class="ib" data-act="closeSheet" aria-label="关闭">${ic('x')}</button></div><div class="sheet-b" data-scroll="sheet">${body}</div>${foot ? `<div class="sheet-f">${foot}</div>` : ''}</div>`;
}

/* ---------- 输入区 ---------- */
function composer(key, ph) {
  const v = S.input[key] || '', has = !!v.trim();
  const mats = S.mats[key] || [];
  return `<div class="composer" data-key="${key}">
    ${mats.length ? `<div class="mats">${mats.map((x, i) => `<span class="mat">${ic(x.icon || 'file', 'xs')}<span>${esc(x.label)}</span><button data-act="matDel" data-arg="${i}" aria-label="移除">${ic('x', 'xs')}</button></span>`).join('')}</div>` : ''}
    <textarea class="c-in" id="c-in" rows="1" placeholder="${esc(ph)}" data-key="${key}" aria-label="输入">${esc(v)}</textarea>
    <div class="c-row">
      <button class="c-btn" data-act="sheet" data-arg="attach" aria-label="添加材料">${ic('plus')}</button>
      <button class="c-model" data-act="sheet" data-arg="model" aria-label="模型">${ic('spark', 'xs')}${MODELS[S.set.model].short}</button>
      <span class="c-sp"></span>
      <button class="c-note" data-act="quickNote" aria-label="记一笔">${ic('pen', 'sm')}<span>记一笔</span></button>
      ${sendBtn(has)}
    </div></div>`;
}
const sendBtn = has => `<button class="c-send${has ? '' : ' mic'}" id="c-send" data-act="${has ? 'send' : 'voice'}" aria-label="${has ? '发送' : '语音'}">${ic(has ? 'up' : 'mic')}</button>`;

/* ---------- 消息 ---------- */
function renderMsg(m, cid) {
  if (m.kind) return CARDS[m.kind] ? CARDS[m.kind](m, cid) : '';
  return m.role === 'user' ? userMsg(m) : aiMsg(m);
}
function userMsg(m) {
  const mats = m.mats && m.mats.length ? `<div class="msg-mats">${m.mats.map(x => `<span class="mat ro">${ic(x.icon || 'file', 'xs')}<span>${esc(x.label)}</span></span>`).join('')}</div>` : '';
  let meta = '';
  if (m.draft) meta = `草稿 · 未发送${S.net && S.ready ? `<button class="btn text" data-act="sendDraft" data-arg="${m.id}">发送</button>` : ''}`;
  else if (!m.synced) meta = `${m.carried ? '从总管带入 · ' : ''}${esc(m.time || '')}`;
  return `<div class="msg user${m.draft ? ' draft' : ''}${m.synced ? ' synced' : ''}" data-mid="${m.id}">${m.synced ? `<div class="who">${esc(m.src)}</div>` : ''}${mats}<div class="bubble">${esc(m.text)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>`;
}
/* 工具过程的摘要用「图标 + 次数」，展开后才是文字。 */
function toolSummary(tools) {
  const c = {};
  tools.forEach(t => { c[t.t] = (c[t.t] || 0) + 1; });
  return Object.entries(c).map(([k, n]) => `<i class="tcount" title="${TOOLS[k].label}">${ic(TOOLS[k].icon, 'xs')}${n}</i>`).join('');
}
function toolsBlock(m) {
  const total = m.tools.reduce((a, t) => a + (t.run ? 0 : t.ms || 0), 0);
  const bad = m.tools.some(t => t.bad), run = m.tools.find(t => t.run);
  const took = total < 1000 ? `${total} 毫秒` : `${(total / 1000).toFixed(1)} 秒`;
  const head = run ? `<span>${TOOLS[run.t].label}…</span>` : `<span class="tsum">${toolSummary(m.tools)}<em>${took}</em></span>`;
  return `<details class="tools${bad ? ' bad' : ''}" data-k="tools-${m.id}"><summary>${ic(run ? 'refresh' : bad ? 'warn' : 'check', run ? 'xs spin' : 'xs')}${head}${ic('right', 'xs chev')}</summary>${m.tools.map(t => {
    const d = TOOLS[t.t];
    return `<div class="tool${t.bad ? ' bad' : ''}">${ic(d.icon, 'xs')}<b>${d.label}</b><time>${t.run ? '…' : `${t.ms} ms`}</time><small><code>${esc(t.arg)}</code>${t.res && !t.run ? ` → ${esc(t.res)}` : ''}</small></div>`;
  }).join('')}</details>`;
}
function aiFoot(m) {
  if (m.synced || m.plain) return m.time && !m.synced ? `<div class="meta">${esc(m.time)}</div>` : '';
  const chips = [];
  if (m.mems && m.mems.length) chips.push(`<button class="fchip" data-act="sheet" data-arg="memused:${m.id}" aria-label="用到 ${m.mems.length} 条记忆">${ic('jar', 'xs')}${m.mems.length}</button>`);
  if (m.usage) chips.push(`<button class="fchip" data-act="sheet" data-arg="usage:${m.id}" aria-label="这一轮的用量">≈${yuan(costOf(m.usage))}</button>`);
  return `<div class="foot">${chips.join('')}<span class="sp"></span><button class="ib" data-act="copyMsg" data-arg="${m.id}" aria-label="复制">${ic('copy', 'sm')}</button><button class="ib" data-act="sheet" data-arg="export:${m.id}" aria-label="导出">${ic('export', 'sm')}</button></div>`;
}
function aiMsg(m) {
  const tools = m.tools && m.tools.length ? toolsBlock(m) : '';
  const body = m.typing ? '<div class="typing"><i></i><i></i><i></i></div>' : `<div class="md${m.streaming ? ' cursor' : ''}">${md(m.text || '')}</div>`;
  const live = m.streaming || m.typing;
  const srcs = m.sources && !live ? `<div class="srcs">${m.sources.map(s => `<button class="src" data-act="toast" data-arg="原型：在浏览器打开 ${esc(s.host)}"><em>${s.n}</em>${esc(s.title)}<small>${esc(s.host)}${m.at ? ` · 检索于 ${m.at}` : ''}</small></button>`).join('')}</div>` : '';
  return `<div class="msg ai${m.synced ? ' synced' : ''}" data-mid="${m.id}">${m.synced ? `<div class="who">${esc(m.src)}</div>` : ''}${tools}${body}${srcs}${live ? '' : aiFoot(m)}</div>`;
}

/* ---------- 对话里的基础卡片 ---------- */
CARDS.day = m => `<div class="day">${esc(m.text)}</div>`;
CARDS.sys = m => `<div class="sysline">${esc(m.text)}</div>`;
CARDS.gap = m => `<div class="sysline gap">${esc(m.text)}</div>`;
CARDS.link = m => `<button class="sysline" data-act="openConv" data-arg="${m.to}">${esc(m.text)} ›</button>`;
CARDS.summary = (m, cid) => `<div class="sumline"><button data-act="sheet" data-arg="summary:${cid}">${ic('layers', 'xs')}更早的 ${m.n} 条已整理成前情摘要</button></div>`;
CARDS.saved = m => {
  const d = { note: ['pen', '记进收件箱'], rem: ['alarm', '提醒已设'], mem: ['jar', '记住了'] }[m.what];
  if (m.undone) return `<div class="savedline undone">${ic('undo', 'xs')}<span>已撤销：${esc(m.text)}</span></div>`;
  return `<div class="savedline">${ic(d[0], 'xs')}<span>${d[1]}：${esc(m.text)}</span><button data-act="undoSaved" data-arg="${m.id}">撤销</button></div>`;
};
CARDS.memask = m => {
  if (m.state === 'yes') return `<div class="savedline">${ic('jar', 'xs')}<span>记住了：${esc(m.text)}</span><button data-act="go" data-arg="memory">查看</button></div>`;
  if (m.state === 'no') return `<div class="sysline">没有记住</div>`;
  return `<div class="card"><div class="card-h">${em('memory', 36)}<div class="t"><b>要记住吗？</b></div></div>
    <div class="quote">${esc(m.text)}</div>
    <div class="btns"><button class="btn pri sm grow" data-act="memYes" data-arg="${m.id}">记住</button><button class="btn ghost sm grow" data-act="memNo" data-arg="${m.id}">不用</button></div></div>`;
};
CARDS.confirm = m => m.state === 'yes' ? CARDS.saved({ ...m, what: 'note', text: m.quote })
  : `<div class="card"><div class="card-h">${tile('shield', 'amber')}<div class="t"><b>确认记入笔记？</b><small>读过外部资料 · ${esc(m.host)}</small></div></div>
  <div class="quote warn">${esc(m.quote)}</div>
  ${m.state ? box('已忽略', 'gray', 'check')
    : `<div class="btns"><button class="btn ghost sm grow" data-act="confirmYes" data-arg="${m.id}">记入笔记</button><button class="btn soft sm grow" data-act="confirmNo" data-arg="${m.id}">忽略</button></div>`}</div>`;
CARDS.ask = m => `<div class="card"><div class="card-h">${em('exec-dsh', 36)}<div class="t"><b>DSH 在等你回答</b></div></div>
  <div class="quote">${esc(m.q)}</div>
  ${m.answer ? box(`${esc(m.answer)} · ${m.sent ? '电脑已收到' : '等电脑上线'}`, m.sent ? 'green' : 'gray', 'check')
    : m.opts.map((o, i) => `<button class="opt" data-act="answer" data-arg="${m.id}:${i}"><span class="t"><b>${esc(o)}</b></span>${ic('right', 'sm')}</button>`).join('')}</div>`;
CARDS.choices = m => `<div class="card">${m.items.map(c => `<button class="opt" data-act="openConv" data-arg="${c.to}">${em(c.img, 36)}<span class="t"><b>${esc(c.title)}</b><small>${esc(c.sub)}</small></span>${ic('right', 'sm')}</button>`).join('')}
  <button class="btn text" data-act="newChat">都不是，开新对话</button></div>`;
CARDS.drafts = m => `<div class="card"><div class="card-h">${em('phone-assistant', 36)}<div class="t"><b>${esc(m.title)}</b></div></div>
  ${m.items.map((d, i) => `<div class="opt${m.picked === i ? ' on' : ''}"><span class="t"><b>「${esc(d.text)}」</b><small>${esc(d.why)}</small></span><button class="ib" data-act="copy" data-arg="${esc(d.text)}" aria-label="复制">${ic('copy', 'sm')}</button>${m.picked == null ? `<button class="btn soft sm" data-act="pickDraft" data-arg="${m.id}:${i}">用这个</button>` : m.picked === i ? ic('check', 'sm') : ''}</div>`).join('')}</div>`;
CARDS.decision = m => `<div class="box tone-violet decision">${em('decision', 26)}<div><b>决定：${esc(m.text)}</b>　没有派工</div></div>`;
CARDS.needkey = () => `<div class="card"><div class="card-h">${tile('key')}<div class="t"><b>还差一步：接入 DeepSeek</b></div></div><button class="btn pri block" data-act="sheet" data-arg="setup">填写 Key</button></div>`;

/* ---------- 列表里的对话名片 ---------- */
function convWhere(c) {
  const p = c.project && PROJECTS[c.project];
  return p ? `${p.name} · ${computerLabel(S.computers[p.device])}` : '只在手机';
}
function convRow(c) {
  const k = KIND[c.kind];
  const lead = c.kind === 'mgr' ? tile('spark') : c.kind === 'chat' ? tile('chat', c.project ? '' : 'gray') : em(k.img, 36);
  const tag = c.kind === 'codex' || c.kind === 'dsh' ? ` <span class="tag ${k.tag}">${k.label}</span>` : '';
  return `<button class="row one" data-act="openConv" data-arg="${c.id}">${lead}<span class="row-t"><b>${esc(c.title)}${tag}</b><small>${esc(convWhere(c))}</small></span><span class="row-r">${esc(c.time)}</span></button>`;
}
