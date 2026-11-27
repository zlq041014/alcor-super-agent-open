/* 运行时：渲染、导航、通用动作、事件，以及手机外面的原型外壳（导览、说明、模拟、全景、规范）。 */
'use strict';
let GEN = 0;
const sleep = ms => new Promise((res, rej) => { const g = GEN; setTimeout(() => (g === GEN ? res() : rej('stale')), S.reduce ? Math.min(ms, 80) : ms); });
const quiet = p => { if (p && p.catch) p.catch(e => { if (e !== 'stale') console.error(e); }); };

/* ================= 渲染 ================= */
const statusbarHTML = () => `<span>${S.clock}</span><span class="sb-r">${ic(S.net ? 'wifi' : 'wifioff')}${ic('signal')}${ic('battery')}</span>`;
const deviceClass = () => `device mode-${S.mode}${S.theme === 'dark' ? ' dark' : ''}${S.reduce ? ' reduce' : ''}`;
function normalize() {
  for (const c of Object.values(S.convs)) for (const m of c.msgs) if (!m.id) m.id = uid('m');
}
function appHTML() {
  if (S.locked) return SCREENS.lock();
  const t = cur();
  let h = (SCREENS[t.n] || SCREENS.home)(t);
  if (S.drawer) h += `<div class="scrim" data-act="closeDrawer"></div>${drawerHTML()}`;
  if (S.sheet) h += `<div class="scrim" data-act="closeSheet"></div>${SHEETS[S.sheet.n](S.sheet)}`;
  if (S.snack) h += `<div class="snack"><span>${ic(S.snack.icon || 'check', 'sm')}${esc(S.snack.text)}</span>${S.snack.undo ? `<button data-act="snackUndo">${S.snack.label || '撤销'}</button>` : ''}</div>`;
  if (S.toast) h += `<div class="toast">${esc(S.toast)}</div>`;
  return h;
}
let lastOverlay = '';
function render() {
  const dev = $('#device'), app = $('#app');
  const scrolls = {};
  $$('[data-scroll]', app).forEach(el => { scrolls[el.dataset.scroll] = el.scrollTop; });
  const opened = new Set($$('details[open][data-k]', app).map(d => d.dataset.k));
  const closed = new Set($$('details:not([open])[data-k]', app).map(d => d.dataset.k));
  const act = document.activeElement;
  const focusId = act && app.contains(act) && act.id ? act.id : null;
  const sel = focusId && act.selectionStart != null ? [act.selectionStart, act.selectionEnd] : null;
  normalize();
  dev.className = deviceClass();
  dev.dataset.screen = cur().n;
  $('#statusbar').innerHTML = statusbarHTML();
  const overlay = (S.sheet ? `s:${S.sheet.n}` : '') + (S.drawer ? 'd' : '');
  app.classList.toggle('still', overlay !== '' && overlay === lastOverlay);
  lastOverlay = overlay;
  app.innerHTML = appHTML();
  S.enter = '';
  $$('[data-scroll]', app).forEach(el => {
    if (S.stick && el.dataset.stick != null) el.scrollTop = el.scrollHeight;
    else if (scrolls[el.dataset.scroll] != null) el.scrollTop = scrolls[el.dataset.scroll];
  });
  S.stick = false;
  $$('details[data-k]', app).forEach(d => { if (opened.has(d.dataset.k)) d.open = true; else if (closed.has(d.dataset.k)) d.open = false; });
  if (focusId) { const el = $(`#app #${focusId}`); if (el) { el.focus(); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* 非文本输入 */ } } }
  growInput();
  syncShell();
}
function growInput() {
  const el = $('#app .c-in');
  if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 110)}px`; }
}
function refreshPet() {
  const a = petNow();
  $$('#app .pet[data-pet="main"], #app .pet[data-pet="sheet"]').forEach(el => { if (!S.pet.drag) el.dataset.anim = a; });
  const cap = $('#app .hero .pet-cap');
  if (cap) cap.outerHTML = petCap();
  renderPetPanel();
}
Pet.onEnd = (id, name) => {
  if (id === 'demo') return petDemoEnd(name);
  if (id !== 'main' || S.pet.shot !== name) return;
  S.pet.shot = null;
  refreshPet();
};

/* ================= 导航与反馈 ================= */
function go(n, p = {}) { S.stack.push({ n, ...p }); S.enter = 'enter'; S.drawer = false; S.sheet = null; render(); }
function back() {
  if (S.sheet) S.sheet = null;
  else if (S.drawer) S.drawer = false;
  else if (S.stack.length > 1) { S.stack.pop(); S.enter = 'enter-back'; }
  render();
}
function openSheet(n, p = {}) { S.sheet = { n, ...p }; render(); }
function closeSheet() { S.sheet = null; render(); }
let toastT, snackT;
function toast(text) {
  S.toast = text; render();
  clearTimeout(toastT);
  const g = GEN;
  toastT = setTimeout(() => { if (g === GEN) { S.toast = null; render(); } }, 2400);
}
function snack(text, undo, opt = {}) {
  S.snack = { text, undo, ...opt }; render();
  clearTimeout(snackT);
  const g = GEN;
  snackT = setTimeout(() => { if (g === GEN) { S.snack = null; render(); } }, 5200);
}
function switchMode(m) {
  if (S.mode === m) return;
  S.mode = m; S.stack = [{ n: 'home' }]; S.sheet = null; S.drawer = false;
  S.snack = null;
  render();
}
const pathGet = p => p.split('.').reduce((o, k) => o[k], S);
function pathSet(p, v) { const ks = p.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], S)[last] = v; }

/* ================= 对话运行 ================= */
function pushMsg(cid, m) { m.id = m.id || uid('m'); S.convs[cid].msgs.push(m); S.stick = true; return m; }
function findMsg(mid) {
  for (const c of Object.values(S.convs)) { const m = c.msgs.find(x => x.id === mid); if (m) return [m, c]; }
  return [null, null];
}
function patchMsg(m, cid) {
  const el = $(`#app [data-mid="${m.id}"]`);
  if (!el) return render();
  const open = el.querySelector('details[open]');
  el.outerHTML = renderMsg(m, cid);
  if (open) { const d = $(`#app [data-mid="${m.id}"] details`); if (d) d.open = true; }
  const sc = $('#app [data-stick]');
  if (sc) sc.scrollTop = sc.scrollHeight;
}
function setBusy(b) { S.busy = b; refreshPet(); }
/* 一轮助手答复：先逐个跑工具（可见），再流式输出正文，最后挂上来源、用量等。 */
async function aiTurn(cid, { tools = [], text, after, ...extra }) {
  const m = pushMsg(cid, { role: 'ai', typing: true, tools: [], text: '' });
  setBusy('think'); render();
  for (const t of tools) {
    const run = { ...t, run: true };
    m.tools.push(run); patchMsg(m, cid);
    await sleep(Math.min(1000, 300 + t.ms / 2));
    run.run = false; patchMsg(m, cid);
  }
  await sleep(tools.length ? 350 : 700);
  m.typing = false; m.streaming = true; setBusy('talk');
  for (let i = 0; i < text.length; i += 3) { m.text = text.slice(0, i + 3); patchMsg(m, cid); await sleep(16); }
  m.text = text; m.streaming = false; m.time = now();
  Object.assign(m, extra);
  setBusy(null);
  const c = S.convs[cid];
  if (c.kind === 'chat' && !c.titled && extra.title) { c.title = extra.title; c.titled = true; c.recent = text.slice(0, 16); }
  if (after) after(m);
  render();
  return m;
}
async function genericReply(cid) {
  await aiTurn(cid, { text: '这是设计原型，只为每个场景准备了示例对话。真实应用里，这句话会发给你配置的 DeepSeek。\n左侧换一个场景，输入框里会预先放好那一场的示例。', plain: true });
}
ACT.send = async () => {
  const key = curConvId();
  const text = (S.input[key] || '').trim();
  if (!key || !text) return;
  S.input[key] = ''; S.typing = false; S.sugg = null;
  const m = pushMsg(key, { role: 'user', text, time: now(), mats: S.mats[key] || [] });
  S.mats[key] = [];
  if (!S.ready) { m.draft = true; S.pending = m.id; pushMsg(key, { kind: 'needkey' }); render(); return openSheet('setup'); }
  if (!S.net) { m.draft = true; render(); return toast('手机没有网络：已存为草稿，联网后由你点发送'); }
  render();
  await runScript(key, text);
};
async function runScript(key, text) {
  const i = S.scripts.findIndex(s => s.conv === key && (!s.text || s.text === text));
  if (i < 0) return genericReply(key);
  const [sc] = S.scripts.splice(i, 1);
  await sc.run(key, text);
}
ACT.sendDraft = async mid => {
  const [m, c] = findMsg(mid);
  if (!m || !S.net || !S.ready) return;
  m.draft = false; m.time = now();
  c.msgs = c.msgs.filter(x => x.kind !== 'needkey');
  render();
  await runScript(c.id, m.text);
};
ACT.fill = text => { const key = curConvId(); S.input[key] = text; render(); const el = $('#app .c-in'); if (el) el.focus(); };

/* ================= 通用动作 ================= */
ACT.back = back;
ACT.go = arg => { const [n, id] = arg.split(':'); go(n, id ? { id } : {}); };
ACT.sheet = arg => { const i = arg.indexOf(':'); openSheet(i < 0 ? arg : arg.slice(0, i), i < 0 ? {} : { id: arg.slice(i + 1) }); };
ACT.closeSheet = closeSheet;
ACT.drawer = () => { S.drawer = true; render(); };
ACT.closeDrawer = () => { S.drawer = false; render(); };
ACT.toast = arg => toast(arg);
ACT.copy = arg => toast(`已复制「${arg.length > 14 ? `${arg.slice(0, 14)}…` : arg}」`);
ACT.copyMsg = () => toast('已复制正文（保留原文，不带出处）');
ACT.tab = arg => { const [k, v] = arg.split(':'); S.tabs[k] = v; render(); };
ACT.flip = path => { pathSet(path, !pathGet(path)); render(); };
ACT.setv = arg => { const i = arg.indexOf('='); pathSet(arg.slice(0, i), arg.slice(i + 1)); render(); };
ACT.mode = arg => switchMode(arg);
ACT.snackUndo = () => { const s = S.snack; S.snack = null; if (s && s.undo) s.undo(); render(); };
ACT.matDel = i => { const key = curConvId(); (S.mats[key] || []).splice(+i, 1); render(); };
ACT.openConv = id => {
  const c = S.convs[id];
  if (!c) return;
  if (c.mode !== S.mode) S.mode = c.mode;
  S.stick = true;
  if (c.kind === 'mgr') { S.stack = [{ n: 'home' }]; S.drawer = false; S.sheet = null; return render(); }
  go('chat', { id });
};
ACT.newChat = () => {
  const id = uid('x');
  S.convs[id] = { id, mode: S.mode, kind: 'chat', title: '新对话', time: '刚刚', recent: '', used: 100, msgs: [] };
  go('chat', { id });
};

/* ================= 事件 ================= */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || !el.closest('#device')) return;
  const fn = ACT[el.dataset.act];
  if (!fn) return;
  if (el.tagName === 'A') e.preventDefault();
  quiet(fn(el.dataset.arg || '', el, e));
});
let typingT;
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.closest || !el.closest('#app')) return;
  if (el.classList.contains('c-in')) {
    const key = el.dataset.key, had = !!(S.input[key] || '').trim();
    S.input[key] = el.value;
    growInput();
    if (had !== !!el.value.trim()) $('#app #c-send').outerHTML = sendBtn(!had);
    S.typing = true; S.pet.sleep = false; refreshPet();
    clearTimeout(typingT);
    const g = GEN;
    typingT = setTimeout(() => { if (g === GEN) { S.typing = false; refreshPet(); } }, 1600);
  } else if (el.dataset.bind) {
    pathSet(el.dataset.bind, el.value);
    if (el.dataset.live != null) render();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return back();
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.target.classList && e.target.classList.contains('c-in')) { e.preventDefault(); quiet(ACT.send()); }
});
let petDown = null;
document.addEventListener('pointerdown', e => {
  const el = e.target.closest && e.target.closest('#app .pet[data-pet="main"]');
  if (!el) return;
  petDown = { el, x: e.clientX, y: e.clientY, drag: false };
  try { el.setPointerCapture(e.pointerId); } catch (err) { /* 合成事件没有指针 */ }
});
document.addEventListener('pointermove', e => {
  if (!petDown) return;
  const dx = e.clientX - petDown.x, dy = e.clientY - petDown.y;
  if (!petDown.drag && Math.hypot(dx, dy) > 5) { petDown.drag = true; S.pet.drag = true; petDown.el.dataset.anim = 'drag'; renderPetPanel(); }
  if (petDown.drag) petDown.el.style.transform = `translate(${dx}px, ${dy}px)`;
});
document.addEventListener('pointerup', () => {
  if (!petDown) return;
  const p = petDown;
  petDown = null;
  if (p.drag) { S.pet.drag = false; p.el.style.transform = ''; } else { S.pet.shot = 'poke'; S.pet.sleep = false; }
  refreshPet();
});

/* ================= 原型外壳 ================= */
let current = 'a1';
function runScenario(id) {
  const sc = SCENARIOS.find(x => x.id === id) || SCENARIOS[0];
  GEN++;
  clearTimeout(toastT); clearTimeout(snackT); clearTimeout(typingT);
  S = freshState(S);
  if (sc.setup) sc.setup(S);
  current = sc.id;
  lastOverlay = '';
  try { history.replaceState(null, '', `?s=${sc.id}`); } catch (e) { /* file:// 下个别浏览器不允许 */ }
  render();
  renderGuide();
  renderNote(sc);
  $('#app').scrollTop = 0;
}
function renderGuide() {
  $('#scenarios').innerHTML = GROUPS.map(g => `<div class="sc-group"><h2>${g.title}<small>${g.ref}</small></h2>${SCENARIOS.filter(s => s.g === g.id).map(s =>
    `<button class="sc-btn" data-s="${s.id}" aria-current="${s.id === current}">${esc(s.title)}<small>${esc(s.sub)}</small></button>`).join('')}</div>`).join('');
}
function renderNote(sc) {
  $('#note').innerHTML = `<span class="goal">${esc(GROUPS.find(g => g.id === sc.g).title)}${sc.refs ? ` · ${esc(sc.refs)}` : ''}</span><h2>${esc(sc.title)}</h2>
    <ul>${sc.points.map(p => `<li>${p}</li>`).join('')}</ul>${sc.try ? `<p class="try"><b>试试：</b>${sc.try}</p>` : ''}`;
}
function renderPetPanel() {
  const el = $('#petpanel');
  if (!el || !S) return;
  const a = petNow(), d = PET.animations[a];
  el.innerHTML = `<h2>小引现在 <small>${S.mode === 'life' ? '生活模式不播工作状态' : '按回执切换'}</small></h2><p><b>${d.label}</b> <code>${a}</code><br>${esc(d.trigger)}</p>`;
}
function syncShell() {
  if (!$('#ctl-net')) return;
  $('#ctl-net').checked = S.net;
  $('#ctl-dark').checked = S.theme === 'dark';
  $('#ctl-reduce').checked = S.reduce;
  $('#ctl-sleep').checked = S.pet.sleep;
  document.body.classList.toggle('dark', S.theme === 'dark');
  for (const k of ['work', 'home']) {
    $$(`#ctl-${k} button`).forEach(b => b.setAttribute('aria-pressed', String((S.computers[k].route || 'off') === b.dataset.v)));
    $(`#sim-${k}`).textContent = computerLabel(S.computers[k]);
  }
  $$('#ctl-part button').forEach(b => b.setAttribute('aria-pressed', String(S.part === b.dataset.v)));
  renderEvidence();
  renderPetPanel();
}
function renderEvidence() {
  const el = $('#evidence');
  const t = typeof mainTask === 'function' ? mainTask() : null;
  el.innerHTML = `<h2>模拟证据 <small>代替电脑和执行端</small></h2>
    <p class="ev-hint">${t ? `当前：${esc(t.title)} · <b>${STAGE[t.stage].label}</b>` : '先在一场挂了项目的对话里把工作「交给电脑」（场景「交接卡」）。'}</p>
    <div class="ev-btns">${EVBTNS.map(b => `<button data-ev="${b.k}" ${t && b.on(t) ? '' : 'disabled'}>${typeof b.label === 'function' ? b.label(t) : b.label}</button>`).join('')}</div>`;
}
function setView(v) {
  for (const k of ['proto', 'board', 'spec']) { $(`#view-${k}`).hidden = k !== v; $(`#tab-${k}`).setAttribute('aria-selected', String(k === v)); }
  if (v === 'board') renderBoard();
  if (v === 'spec') renderSpec();
  window.scrollTo(0, 0);
}
/* 全景：每个场景的初始画面缩小排开，点一张回到可点击原型。 */
function renderBoard() {
  const keep = S;
  let h = '';
  for (const g of GROUPS) {
    h += `<section class="board-sec"><h2>${g.title}<small>${g.ref}</small></h2><div class="board-grid">`;
    for (const sc of SCENARIOS.filter(s => s.g === g.id)) {
      S = freshState(keep);
      if (sc.setup) sc.setup(S);
      normalize();
      h += `<figure class="mini" data-s="${sc.id}"><div class="mini-wrap"><div class="${deviceClass()}"><div class="statusbar">${statusbarHTML()}</div><div class="app">${appHTML()}</div><div class="gesture"><i></i></div></div></div><figcaption><b>${esc(sc.title)}</b><small>${esc(sc.sub)}</small></figcaption></figure>`;
    }
    h += '</div></section>';
  }
  S = keep;
  $('#view-board').innerHTML = h;
  $$('#view-board [data-stick]').forEach(el => { el.scrollTop = el.scrollHeight; });
}

function boot() {
  $('#scenarios').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (b) { runScenario(b.dataset.s); document.body.classList.remove('guide-open'); } });
  $('#view-board').addEventListener('click', e => { const f = e.target.closest('[data-s]'); if (f) { setView('proto'); runScenario(f.dataset.s); } });
  $('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  $('#ctl-net').addEventListener('change', e => { S.net = e.target.checked; render(); toast(S.net ? '手机联网了' : '手机没有网络：能看记录、能记一笔、能存草稿'); });
  $('#ctl-dark').addEventListener('change', e => { S.theme = e.target.checked ? 'dark' : 'light'; render(); });
  $('#ctl-reduce').addEventListener('change', e => { S.reduce = e.target.checked; render(); });
  $('#ctl-sleep').addEventListener('change', e => { S.pet.sleep = e.target.checked; render(); });
  for (const k of ['work', 'home']) $(`#ctl-${k}`).addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) quiet(computerSim(k, b.dataset.v === 'off' ? null : b.dataset.v)); });
  $('#ctl-part').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) { S.part = b.dataset.v; S.clock = b.dataset.t; render(); } });
  $('#evidence').addEventListener('click', e => { const b = e.target.closest('[data-ev]'); if (b && !b.disabled) quiet(evidence(b.dataset.ev)); });
  $('#guide-fab').addEventListener('click', () => document.body.classList.toggle('guide-open'));
  const q = new URLSearchParams(location.search);
  S = freshState(null);
  if (q.get('dark') === '1') S.theme = 'dark';
  runScenario(q.get('s') || 'a1');
  if (q.get('view')) setView(q.get('view'));
}
document.addEventListener('DOMContentLoaded', boot);
