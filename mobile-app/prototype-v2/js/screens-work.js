/* 工作：交接卡、回执与验收、项目与 Agent 结构、电脑与连接路线、决定冲突。
   规则沿用首版：已选目标上的明确发送才算授权；状态只跟回执走；结果回到原对话。 */
'use strict';

/* ================= 交接与回执 ================= */
function newTask(extra = {}) {
  const word = S.flags.decision || '继续';
  const t = {
    id: uid('t'), req: `req-${(0x3a7f + Object.keys(S.tasks).length * 0x1d3).toString(16)}`, stage: 'draft', conv: 'd-login',
    title: `登录页主按钮改为「${word}」`, device: 'work', project: 'alcor-web', exec: 'codex', target: '原会话「登录页重构」', native: true,
    perms: '只改 src/pages/login/**；不提交、不推送', accept: `按钮显示「${word}」；构建和登录页测试通过`,
    mats: ['决定 1 条', '讨论摘录 2 段'], log: [], diff: null, ...extra,
  };
  S.tasks[t.id] = t;
  return t;
}
const mainTask = () => taskList().filter(t => t.stage !== 'draft' && t.stage !== 'cancelled').slice(-1)[0] || null;
function tlog(t, text, kind = '') { t.log.push({ time: now(), text, kind }); }
function syncTaskEvent(t) {
  S.events = S.events.filter(e => e.task !== t.id);
  const type = { review: 'review', failed: 'failed', verify: 'verify', done: 'done' }[t.stage];
  if (type) S.events.unshift({ id: uid('e'), mode: 'work', type, title: t.title, sub: `${computerLabel(S.computers[t.device])} · ${EXEC[t.exec].label}`, time: S.clock, unread: true, open: type !== 'done', task: t.id });
}
function setStage(t, stage) { t.stage = stage; syncTaskEvent(t); }
const taskDiff = () => ({ file: 'src/pages/login/SubmitButton.tsx', del: '立即登录并进入工作台', add: S.flags.decision || '继续' });

async function confirmTask(tid) {
  const t = S.tasks[tid];
  if (!t || t.stage !== 'draft') return;
  tlog(t, '你在手机上点了「交给电脑」（一次授权）');
  setStage(t, 'local');
  tlog(t, '已保存在手机，尚未发送');
  render();
  const c = S.computers[t.device];
  if (c.online && S.net) await deliver(t, 'ok'); else toast(`已记下 · ${computerLabel(c)}离线，上线后核对再发`);
}
async function deliver(t, mode) {
  const c = S.computers[t.device];
  setStage(t, 'sending');
  tlog(t, `${computerLabel(c)}在线（${ROUTE[c.route].label}）：核对身份、授权、版本和有效期`);
  render();
  await sleep(900);
  if (t.stage !== 'sending') return;
  if (mode === 'lost') { setStage(t, 'verify'); tlog(t, `已发出 ${t.req}，没有收到匹配的回执`, 'warn'); }
  else { setStage(t, 'received'); tlog(t, `Hub 回执：已登记 ${t.req}，排队等待执行`); S.pet.shot = 'handoff'; }
  render();
}
/* 右侧「模拟环境」切换电脑的在线和路线。 */
async function computerSim(k, route) {
  const c = S.computers[k];
  setOnline(c, route);
  render();
  if (!route) return;
  if (!S.net) return toast('手机还没联网：待发的请求留在手机上');
  for (const t of taskList()) if (t.device === k && t.stage === 'local') await deliver(t, S.flags.lose ? 'lost' : 'ok');
  for (const cv of Object.values(S.convs)) for (const m of cv.msgs) if (m.kind === 'ask' && m.answer && !m.sent && PROJECTS[cv.project].device === k) m.sent = true;
  render();
}
const EVBTNS = [
  { k: 'online', label: t => t ? `${esc(computerLabel(S.computers[t.device]))}上线，回执正常` : '电脑上线，回执正常', on: t => t.stage === 'local' },
  { k: 'lost', label: '上线，但回执丢了', on: t => t.stage === 'local' },
  { k: 'found', label: '核对：Hub 有这条请求', on: t => t.stage === 'verify' },
  { k: 'missing', label: '核对：Hub 没有', on: t => t.stage === 'verify' },
  { k: 'start', label: '执行端：回合开始', on: t => t.stage === 'received' },
  { k: 'finish', label: '执行端：回合结束，有结果', on: t => t.stage === 'running' },
  { k: 'fail', label: '执行端：回合失败', on: t => t.stage === 'running' },
  { k: 'replay', label: '重放一条旧事件', on: t => ['running', 'review', 'done'].includes(t.stage) },
];
async function evidence(k) {
  const t = mainTask();
  if (!t) return;
  const ex = `${EXEC[t.exec].label}${t.target}`;
  if (k === 'online' || k === 'lost') { S.flags.lose = k === 'lost'; await computerSim(t.device, 'relay'); S.flags.lose = false; return; }
  if (k === 'found') { setStage(t, 'received'); tlog(t, `核对：Hub 已有 ${t.req}，不重发`); S.pet.shot = 'handoff'; }
  if (k === 'missing') {
    tlog(t, `核对：Hub 和原生记录里都没有 ${t.req}；按原请求补发`, 'warn'); render();
    await sleep(700);
    setStage(t, 'received'); tlog(t, `Hub 回执：已登记 ${t.req}`); S.pet.shot = 'handoff';
  }
  if (k === 'start') { setStage(t, 'running'); tlog(t, `${ex}：回合 #15 开始`); }
  if (k === 'finish') { t.diff = taskDiff(); setStage(t, 'review'); tlog(t, '回合 #15 结束：改动 1 个文件，构建和登录页测试通过'); }
  if (k === 'fail') { t.reason = '登录页测试有 1 项断言还是旧文案'; setStage(t, 'failed'); tlog(t, `回合 #15 失败：${t.reason}`, 'bad'); }
  if (k === 'replay') return toast(`重复的事件：按 ${t.req} 去重，没有新增消息，也没有再通知`);
  render();
}
/* 场景预设：把一项交接直接放到某个阶段，回执记录补齐。 */
function presetTask(stage, extra = {}) {
  const t = newTask(extra), c = S.computers[t.device], ex = `${EXEC[t.exec].label}${t.target}`;
  const path = { local: ['local'], received: ['local', 'received'], verify: ['local', 'verify'], running: ['local', 'received', 'running'], review: ['local', 'received', 'running', 'review'], done: ['local', 'received', 'running', 'review', 'done'], failed: ['local', 'received', 'running', 'failed'] }[stage] || [];
  const say = {
    local: [['你在手机上点了「交给电脑」（一次授权）'], ['已保存在手机，尚未发送']],
    received: [[`${computerLabel(c)}上线：核对身份、授权、版本和有效期`], [`Hub 回执：已登记 ${t.req}，排队等待执行`]],
    verify: [[`${computerLabel(c)}上线：核对身份、授权、版本和有效期`], [`已发出 ${t.req}，没有收到匹配的回执`, 'warn']],
    running: [[`${ex}：回合 #15 开始`]],
    review: [['回合 #15 结束：改动 1 个文件，构建和登录页测试通过']],
    done: [['你核对了改动，验收通过']],
    failed: [['回合 #15 失败：登录页测试有 1 项断言还是旧文案', 'bad']],
  };
  for (const s of path) { say[s].forEach(([text, kind]) => tlog(t, text, kind)); t.stage = s; }
  if (['review', 'done'].includes(stage)) t.diff = taskDiff();
  if (stage === 'failed') t.reason = '登录页测试有 1 项断言还是旧文案';
  syncTaskEvent(t);
  return t;
}

/* 进度条：对话里只画五段，回执页才带文字。 */
function stepsHTML(t, labels = false) {
  const s = STAGE[t.stage];
  return `<div class="steps tone-${s.tone}${labels ? '' : ' bare'}">${STEPS.map((label, i) => {
    const n = i + 1, cls = n < s.step ? 'on' : n === s.step ? `on cur ${s.mark || ''}` : '';
    return `<span class="stp ${cls}"><i></i>${labels ? label : ''}</span>`;
  }).join('')}</div>`;
}
const taskWhere = t => { const c = S.computers[t.device]; return `<i class="dot ${c.online ? 'on' : 'off'}"></i>${esc(computerLabel(c))} · ${esc(PROJECTS[t.project].name)}`; };
/* 授权内容：发到哪个会话、带上什么、权限、怎么算做完。每行用图标标注。 */
function hoRows(t) {
  const field = (icon, label, value) => `<div><dt title="${label}">${ic(icon, 'sm')}<span>${label}</span></dt><dd>${value}</dd></div>`;
  return `<dl class="ho-rows">
    ${field('pin', '发往', `<span class="tag ${t.exec}">${EXEC[t.exec].label}</span> ${esc(t.target)}`)}
    ${field('layers', '带上', t.mats.map(x => `<span class="chip sm">${esc(x)}</span>`).join(' '))}
    ${field('shield', '权限', esc(t.perms))}
    ${field('check', '验收', esc(t.accept))}</dl>`;
}
function taskExtra(t) {
  switch (t.stage) {
    case 'local': return `<div class="btns"><button class="btn ghost sm" data-act="sheet" data-arg="target:${t.id}">${ic('pen', 'sm')}修改</button><button class="btn danger sm" data-act="taskCancel" data-arg="${t.id}">${ic('undo', 'sm')}撤销</button></div>`;
    case 'verify': return box(`按原请求 ${t.req} 核对中，不重发`, 'amber', 'warn');
    case 'review': return `<pre class="diff"><span>${esc(t.diff.file)}</span>\n<span class="del">- ${esc(t.diff.del)}</span>\n<span class="add">+ ${esc(t.diff.add)}</span></pre>
      <div class="btns"><button class="btn pri grow" data-act="taskAccept" data-arg="${t.id}">${ic('check', 'sm')}验收</button><button class="ibtn" data-act="toast" data-arg="原型：打开 Codex 原会话「登录页重构」的回合 #15" aria-label="原会话">${ic('ext')}</button></div>`;
    case 'failed': return `${box(esc(t.reason), 'red', 'warn')}<div class="btns"><button class="btn pri sm" data-act="taskRetry" data-arg="${t.id}">改条件重发</button></div>`;
    default: return '';
  }
}
function renderTask(t) {
  if (!t) return '';
  if (t.stage === 'draft') return `<div class="card handoff">
    <div class="card-h">${em('handoff', 44)}<div class="t"><b>${esc(t.title)}</b><small>${taskWhere(t)}</small></div></div>
    ${hoRows(t)}
    <div class="btns"><button class="btn pri grow" data-act="taskConfirm" data-arg="${t.id}">${ic('up', 'sm')}交给电脑</button><button class="ibtn" data-act="sheet" data-arg="target:${t.id}" aria-label="改目标">${ic('pen')}</button><button class="ibtn" data-act="taskDismiss" data-arg="${t.id}" aria-label="先不发">${ic('x')}</button></div></div>`;
  if (t.stage === 'cancelled') return `<div class="sysline">已撤销：${esc(t.title)}</div>`;
  return `<div class="card handoff"><button class="card-h" data-act="go" data-arg="receipt:${t.id}" aria-label="查看回执">${em(EXEC[t.exec].img, 44)}<span class="t"><b>${esc(t.title)}</b><small>${taskWhere(t)}</small></span>${ic('right', 'sm')}</button>
    <div class="hand-state">${stageBadge(t)}</div>${stepsHTML(t)}${taskExtra(t)}</div>`;
}
CARDS.handoff = m => renderTask(S.tasks[m.task]);
ACT.taskConfirm = id => confirmTask(id);
ACT.taskDismiss = id => { const t = S.tasks[id]; setStage(t, 'cancelled'); render(); toast('没有发送。需要时再说一声'); };
ACT.taskCancel = id => {
  const t = S.tasks[id];
  if (t.stage !== 'local') return;
  tlog(t, '你撤销了这条待发的请求；不会派发', 'bad'); setStage(t, 'cancelled'); render(); toast('已撤销，不会派发');
};
ACT.taskAccept = id => {
  const t = S.tasks[id];
  if (t.stage !== 'review') return;
  tlog(t, '你核对了改动，验收通过'); setStage(t, 'done');
  S.events.forEach(e => { if (e.task === t.id) e.unread = false; });
  pushMsg(t.conv, { kind: 'sys', text: `结果已回到这里：${t.title} · 已完成` });
  S.pet.shot = 'done';
  render();
};
ACT.taskRetry = id => {
  const t = S.tasks[id];
  if (t.stage !== 'failed') return;
  const n = newTask({ accept: `${t.accept}；同步更新登录页测试里的断言` });
  setStage(t, 'cancelled');
  pushMsg(t.conv, { role: 'ai', plain: true, time: now(), text: '失败原因是测试还在断言旧文案。我把“更新测试断言”加进了验收条件，生成一条新的请求，你确认后再发：' });
  pushMsg(t.conv, { kind: 'handoff', task: n.id });
  S.stack = [{ n: 'home' }, { n: 'chat', id: t.conv }]; S.sheet = null; S.stick = true;
  render();
};
SHEETS.target = ({ id }) => {
  const t = S.tasks[id];
  const opts = [
    { k: 'native', exec: 'codex', title: '原会话「登录页重构」' },
    { k: 'codex', exec: 'codex', title: '新建托管工作 · Codex' },
    { k: 'dsh', exec: 'dsh', title: '新建托管工作 · DSH' },
  ];
  const curK = t.native ? 'native' : t.exec;
  const cur = S.computers[t.device], other = S.computers.home;
  return sheet('发到哪里', `${opts.map(o => `<button class="opt${curK === o.k ? ' on' : ''}" data-act="taskTarget" data-arg="${id}|${o.k}">${em(EXEC[o.exec].img, 36)}<span class="t"><b>${o.title}</b></span>${curK === o.k ? ic('check', 'sm') : ''}</button>`).join('')}
    <div class="opt" style="opacity:.55">${em('computer-asleep', 36)}<span class="t"><b>${esc(computerLabel(other))}上的 alcor-web</b><small>同名的另一份，不会自动选</small></span></div>`, { sub: `${esc(computerLabel(cur))} · alcor-web` });
};
ACT.taskTarget = arg => {
  const [id, k] = arg.split('|'), t = S.tasks[id];
  const o = { native: ['codex', '原会话「登录页重构」', true], codex: ['codex', '新建托管工作', false], dsh: ['dsh', '新建托管工作', false] }[k];
  [t.exec, t.target, t.native] = o;
  if (t.stage === 'local') { t.req = `${t.req}b`; tlog(t, `你修改了目标，换成新的请求 ${t.req}`); }
  S.sheet = null; render();
};

/* ================= 回执详情 ================= */
SCREENS.receipt = ({ id }) => {
  const t = S.tasks[id];
  const reached = ['received', 'running', 'review', 'done', 'failed'].includes(t.stage);
  const result = t.diff ? `${sec('结果')}<div class="card" style="margin:0 14px"><div class="card-h">${tile('file', 'green')}<div class="t"><b>${esc(t.diff.file.split('/').pop())}</b><small>回合 #15 · 测试通过</small></div><button class="ibtn sm" data-act="sheet" data-arg="export:x" aria-label="导出">${ic('export', 'sm')}</button></div>
      <pre class="diff"><span class="del">- ${esc(t.diff.del)}</span>\n<span class="add">+ ${esc(t.diff.add)}</span></pre></div>` : '';
  return page({
    title: '回执', sub: t.req,
    body: `<div class="pb">
      <div class="card" style="margin:4px 14px 0"><div class="card-h">${em(EXEC[t.exec].img, 44)}<div class="t"><b>${esc(t.title)}</b><small>${taskWhere(t)}</small></div></div>
        <div class="hand-state">${stageBadge(t)}</div>${stepsHTML(t, true)}${taskExtra(t).replace(/<pre class="diff">[\s\S]*?<\/pre>/, '')}</div>
      ${result}
      <details class="fold" data-k="auth-${t.id}"><summary>${ic('shield', 'sm')}<span>授权内容</span>${ic('right', 'sm chev')}</summary><div class="card">${hoRows(t)}${reached ? box('电脑收到 3 份材料', 'green', 'check') : ''}</div></details>
      <details class="fold" data-k="log-${t.id}"><summary>${ic('clock', 'sm')}<span>回执记录</span><small>${t.log.length} 条</small>${ic('right', 'sm chev')}</summary>
        <div class="card log">${t.log.map(l => `<div class="log-i ${l.kind}"><time>${l.time}</time><span>${esc(l.text)}</span></div>`).join('')}</div></details></div>`,
  });
};

/* ================= 待答问题、文案决定 ================= */
ACT.answer = arg => {
  const [mid, i] = arg.split(':'), [m, c] = findMsg(mid);
  m.answer = m.opts[+i];
  m.sent = S.computers[PROJECTS[c.project].device].online && S.net;
  const e = S.events.find(x => x.id === m.event);
  if (e) { e.open = false; e.unread = false; e.type = 'done'; e.title = `已回答：${m.answer}`; }
  render();
  toast(m.sent ? '回答已发回原会话的这一回合' : '已记下，等电脑上线后发回原会话');
};
ACT.pickDraft = arg => {
  const [mid, i] = arg.split(':'), [m, c] = findMsg(mid);
  m.picked = +i;
  S.flags.decision = m.items[+i].text;
  pushMsg(c.id, { kind: 'decision', text: `按钮用「${S.flags.decision}」`, ver: 1 });
  render();
  if (S.flags.afterPick) S.flags.afterPick(c);
};

/* ================= 项目与 Agent 结构 ================= */
function agentNodes(pid) {
  const t = mainTask();
  const out = [];
  let skipBelow = null;
  for (const n of AGENTS[pid] || []) {
    if (skipBelow != null && n.d > skipBelow) continue;
    skipBelow = null;
    if (n.task) {
      if (!t || t.project !== pid) { skipBelow = n.d; continue; }
      const map = { local: 'phone', sending: 'phone', received: 'queued', verify: 'unknown', running: 'running', review: 'review', done: 'done', failed: 'failed' };
      out.push({ ...n, name: t.title, state: map[t.stage], act: t.log[t.log.length - 1].time, taskId: t.id });
      continue;
    }
    const parentTask = out.length && out[out.length - 1].taskId && n.d > out[out.length - 1].d;
    out.push(parentTask ? { ...n, state: t.stage === 'done' ? 'done' : 'wait' } : n);
  }
  return out;
}
function nodeIcon(n) {
  return n.exec === 'mgr' ? tile('spark') : n.exec === 'chat' ? tile('chat') : em(EXEC[n.exec].img, 36);
}
function nodeBadge(n) {
  if (n.state === 'phone') return `<span class="st tone-gray dashed">还在手机上</span>`;
  const s = ASTATE[n.state];
  return badge(s.label, s.tone);
}
SCREENS.projects = () => page({
  title: '项目与 Agent',
  body: `<div class="pb">
    ${Object.values(S.computers).map(c => sec(esc(computerLabel(c)), `<small class="plain">${c.online ? '在线' : '缓存'}</small>`)
      + group(Object.values(PROJECTS).filter(p => p.device === c.id).map(p => {
        const hot = agentNodes(p.id).find(n => ['question', 'review', 'failed', 'unknown', 'running', 'queued'].includes(n.state));
        return row({ icon: 'folder', title: esc(p.name), right: hot ? nodeBadge(hot) : '', act: 'go', arg: `project:${p.id}` });
      }))).join('')}</div>`,
});
const DECISIONS = {
  'alcor-web': [
    { id: 'k1', text: '按钮文案用动词开头，不超过四个字', ver: 2, scope: '整个项目', src: '11-24 对话「登录页改版」' },
    { id: 'k2', text: '登录页主按钮用「继续」', ver: 1, scope: '这次登录页改动', src: '手机 · 今天 10:12', flag: 'conflict' },
  ],
};
SCREENS.project = ({ id }) => {
  const p = PROJECTS[id], c = S.computers[p.device], tab = S.tabs.project;
  let body = '';
  if (tab === 'tree') {
    let hiddenDepth = -1;
    const branch = S.flags.collapsedAgents || {};
    const nodes = agentNodes(id);
    body = `<div class="tree">${nodes.map((n, i) => {
      if (hiddenDepth >= 0 && n.d > hiddenDepth) return '';
      hiddenDepth = -1;
      const hasChildren = (nodes[i + 1]?.d ?? -1) > n.d;
      if (hasChildren && branch[n.id]) hiddenDepth = n.d;
      return `<div class="node-branch">${hasChildren ? `<button class="ib agent-fold" data-act="foldAgent" data-arg="${esc(n.id)}" aria-label="${branch[n.id] ? '展开' : '折叠'}">${ic('right','xs')}</button>` : ''}<button class="node" style="--d:${n.d}" data-act="sheet" data-arg="node:${id}|${n.id}">${nodeIcon(n)}<span class="node-t"><b>${esc(n.name)}</b><small>${n.role}${n.act !== '—' ? ` · ${esc(n.act)}` : ''}</small></span>${nodeBadge(n)}</button></div>`;
    }).join('')}</div>
      ${(NATIVE[id] || []).length ? sec('原生会话') + group(NATIVE[id].map(n => row({ img: EXEC[n.exec].img, title: `${esc(n.name)} <span class="tag ${n.exec}">${EXEC[n.exec].label}</span>`, right: esc(n.act), act: 'openConv', arg: n.conv, chev: false }))) : ''}`;
  } else if (tab === 'convs') {
    const rows = Object.values(S.convs).filter(x => x.project === id);
    body = rows.length ? group(rows.map(convRow)) : `<div class="empty"><b>还没有对话</b></div>`;
  } else {
    const ds = DECISIONS[id] || [];
    body = ds.length ? group(ds.map(d => {
      const clash = d.flag === 'conflict' && S.flags.conflict && !S.flags.conflictPick;
      return row({ icon: 'check', tone: clash ? 'amber' : 'violet', title: esc(d.id === 'k2' && S.flags.conflictPick ? `登录页主按钮用「${S.flags.conflictPick}」` : d.text), sub: `${d.scope} · 第 ${d.ver} 版`, right: clash ? badge('两处都改过', 'amber') : '', act: clash ? 'sheet' : 'toast', arg: clash ? 'conflict' : '原型：查看这条决定引用的原话', chev: false });
    })) : `<div class="empty">${em('decision', 88)}<b>还没有决定</b></div>`;
  }
  return page({
    title: esc(p.name), sub: `<i class="dot ${c.online ? 'on' : 'off'}"></i>${esc(computerLabel(c))}`,
    head: `<div class="seg-wrap">${seg([['tree', 'Agent'], ['convs', '对话'], ['rules', '决定']], tab, 'tabProject')}</div>`,
    body: `<div class="pb">${c.online ? '' : `<div style="padding:0 14px 10px">${box(`离线，以下是 ${p.sync} 的缓存`, 'amber', 'clock')}</div>`}${body}</div>`,
  });
};
ACT.tabProject = v => { S.tabs.project = v; render(); };
ACT.foldAgent = id => { const state = S.flags.collapsedAgents ||= {}; state[id] = !state[id]; render(); };
SHEETS.node = ({ id }) => {
  const [pid, nid] = id.split('|'), n = agentNodes(pid).find(x => x.id === nid), p = PROJECTS[pid];
  const isTarget = S.flags.target === `${pid}|${nid}`;
  return sheet(esc(n.name), `
    <div class="card"><div class="card-h">${nodeIcon(n)}<div class="t"><b>${n.role}</b><small>${esc(n.model)}</small></div>${nodeBadge(n)}</div></div>
    <div class="btns">${n.conv ? `<button class="btn ghost grow" data-act="openConv" data-arg="${n.conv}">${ic('chat', 'sm')}会话</button>` : ''}${n.taskId ? `<button class="btn ghost grow" data-act="go" data-arg="receipt:${n.taskId}">${ic('file', 'sm')}回执</button>` : ''}${n.exec === 'mgr' ? '' : `<button class="btn ${isTarget ? 'soft' : 'pri'} grow" data-act="nodeTarget" data-arg="${id}">${ic(isTarget ? 'check' : 'pin', 'sm')}${isTarget ? '已是目标' : '设为目标'}</button>`}</div>`, { sub: `${esc(p.name)}${n.act !== '—' ? ` · ${esc(n.act)}` : ''}` });
};
ACT.nodeTarget = id => { S.flags.target = S.flags.target === id ? null : id; render(); };

/* ================= 决定在两处被改 ================= */
SHEETS.conflict = () => {
  const ver = (k, icon, when) => `<button class="opt${S.flags.conflictPick === k ? ' on' : ''}" data-act="conflictPick" data-arg="${k}">${tile(icon, 'gray')}<span class="t"><b>「${k}」</b><small>${when}</small></span>${S.flags.conflictPick === k ? ic('check', 'sm') : ''}</button>`;
  return sheet('两处都改过，选一个', `${ver('继续', 'phone', '手机 · 今天 10:12')}${ver('登录', 'monitor', `${esc(computerLabel(S.computers.work))} · 今天 09:40`)}
    <div class="hint center">两版都保留着，不会自动派工</div>`,
  { foot: `<button class="btn pri block" data-act="closeSheet" ${S.flags.conflictPick ? '' : 'disabled'}>用这一版</button>` });
};
ACT.conflictPick = k => { S.flags.conflictPick = k; S.flags.decision = k; render(); };

/* ================= 电脑与连接路线 ================= */
function routeState(r, c) {
  if (r.ok === null) return `<span class="st tone-gray dashed">没有配置</span>`;
  if (c.route === r.k) return badge(`正在用 · ${r.ms} ms`, ROUTE[r.k].tone);
  if (r.ok) return `<span class="st tone-gray">可达 · ${r.ms} ms</span>`;
  return `<span class="st tone-gray">不可达</span>`;
}
SCREENS.computers = () => page({
  title: '电脑',
  body: `<div class="pb">
    <div class="comp-list">${Object.values(S.computers).map(c => `<button class="card comp" data-act="go" data-arg="computer:${c.id}">
      <div class="card-h">${c.online ? tile('monitor', 'green') : em('computer-asleep', 36)}<div class="t"><b>${esc(computerLabel(c))}</b></div>${c.online ? badge(ROUTE[c.route].label, ROUTE[c.route].tone) : badge('离线', 'gray')}</div>
      <div class="route-mini">${c.routes.map(r => `<span class="${c.route === r.k ? 'cur tone-' + ROUTE[r.k].tone : r.ok ? 'ok' : r.ok === null ? 'none' : 'bad'}"><i>${ROUTE[r.k].rank}</i>${ROUTE[r.k].label}</span>`).join('')}</div></button>`).join('')}</div>
    <div style="padding:14px"><button class="btn ghost block" data-act="sheet" data-arg="pair">${ic('plus', 'sm')}配对一台电脑</button></div></div>`,
});
SCREENS.computer = ({ id }) => {
  const c = S.computers[id];
  const shared = new Set(Object.values(PROJECTS).filter(p => p.device === id).map(p => p.name)).size;
  return page({
    title: esc(computerLabel(c)), sub: `<i class="dot ${c.online ? 'on' : 'off'}"></i>${c.online ? ROUTE[c.route].label : `离线 · ${c.last}`}`,
    body: `<div class="pb">${sec('路线', '<small class="plain">优先用靠前的</small>')}
      <div class="group">${c.routes.map(r => `<div class="row route${c.route === r.k ? ' cur' : ''}"><span class="rk tone-${ROUTE[r.k].tone}">${ROUTE[r.k].rank}</span><span class="row-t"><b>${ROUTE[r.k].label}</b></span>${routeState(r, c)}</div>`).join('')}</div>
      ${sec('经中继传')}${group([
        row({ icon: 'text', title: '文字', right: badge('始终', 'green', false) }),
        row({ icon: 'file', title: '附件原件', right: tg(S.flags.relayFiles, 'flip', 'flags.relayFiles', '经中继发送附件原件') }),
      ])}
      ${sec('这台电脑')}${group([
        row({ icon: 'monitor', title: '设备名称', right: esc(c.name), chev: false }),
        row({ icon: 'pen', title: '备注', right: c.remark ? esc(c.remark) : '<small>未备注</small>', act: 'editRemark', arg: c.id }),
        row({ icon: 'folder', title: '共享的项目', right: String(shared), act: 'go', arg: 'projects' }),
        row({ icon: 'shieldok', title: '配对', right: c.paired, act: 'toast', arg: '原型：显示证书指纹的前后几位' }),
        row({ icon: 'trash', tone: 'red', title: '撤销配对', act: 'toast', arg: '原型：撤销前会再问一次', chev: false }),
      ])}</div>`,
  });
};
SHEETS.remark = ({ id }) => {
  const c = S.computers[id];
  return sheet('电脑备注', `<div class="form"><label><span>备注</span>
    <input class="field" id="remark-in" maxlength="20" value="${esc(S.flags.remarkEdit || '')}" placeholder="${esc(c.name)}" data-bind="flags.remarkEdit">
    <small class="hint">留空就显示设备名称 ${esc(c.name)}。</small></label></div>`,
  { foot: `${c.remark ? `<button class="btn ghost" data-act="remarkClear" data-arg="${id}">清除</button>` : ''}<button class="btn pri grow" data-act="remarkSave" data-arg="${id}">保存</button>` });
};
ACT.editRemark = id => { S.flags.remarkEdit = S.computers[id].remark || ''; S.sheet = { n: 'remark', id }; render(); };
ACT.remarkSave = id => {
  const c = S.computers[id];
  c.remark = (S.flags.remarkEdit || '').trim().slice(0, 20);
  S.flags.remarkEdit = '';
  S.sheet = null; render();
  toast(c.remark ? '备注已保存' : '已清除备注，显示设备名称');
};
ACT.remarkClear = id => {
  S.computers[id].remark = '';
  S.flags.remarkEdit = '';
  S.sheet = null; render();
  toast('已清除备注，显示设备名称');
};
SHEETS.pair = () => sheet('配对一台电脑', `${hero('handoff')}
  <input class="field" placeholder="粘贴配对码" autocomplete="off">
  <div class="hint center">${ic('monitor', 'xs')}电脑：设置 → 手机接入　${ic('wifi', 'xs')}同一局域网</div>`,
{ foot: `<button class="btn pri block" data-act="toast" data-arg="原型：校验配对码里的证书指纹，然后同步项目名片">配对</button>` });
