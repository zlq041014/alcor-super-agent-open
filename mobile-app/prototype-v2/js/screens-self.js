/* 记得你：记忆、人格、权限；以及设置、模型、用量、通知、存储、应用锁与备份。
   行里只放图标和标题，当前值放在右侧，不配说明文字。 */
'use strict';
const spaced = html => html.replace('class="group"', 'class="group" style="margin-top:22px"');

/* ================= 记忆 ================= */
SCREENS.memory = () => {
  const tab = S.mode === 'life' ? 'life' : S.tabs.mem === 'project' ? 'project' : 'work';
  const list = S.mems.filter(m => m.scope === tab);
  const cands = list.filter(m => m.kind === 'cand'), kept = list.filter(m => m.kind !== 'cand');
  const cnt = k => S.mems.filter(m => m.scope === k && m.kind !== 'cand' && m.on).length;
  const memRow = m => `<div class="mem${m.on ? '' : ' off'}"><button class="mem-t" data-act="sheet" data-arg="mem:${m.id}"><b>${esc(m.text)}</b><small>${m.project ? `${esc(PROJECTS[m.project].name)} · ` : ''}${esc(m.src)}</small></button>${tg(m.on, 'memFlip', m.id, m.text)}</div>`;
  return page({
    title: '记忆',
    head: `<div class="seg-wrap">${seg(S.mode === 'life' ? [['life', `生活 ${cnt('life')}`]]
      : [['work', `工作 ${cnt('work')}`], ['project', `项目 ${cnt('project')}`]], tab, 'tabMem')}</div>`,
    body: `<div class="pb">
      ${cands.length ? sec('要记住吗') + `<div class="cand-list">${cands.map(m => `<div class="card"><div class="quote">${esc(m.text)}</div><div class="hint">${esc(m.src)}</div><div class="btns"><button class="btn pri sm grow" data-act="memKeep" data-arg="${m.id}">记住</button><button class="btn ghost sm grow" data-act="memDrop" data-arg="${m.id}">不用</button></div></div>`).join('')}</div>` : ''}
      ${kept.length ? sec('记住的') + `<div class="group">${kept.map(memRow).join('')}</div>` : `<div class="empty">${em('memory', 88)}<b>还没有记忆</b></div>`}
    </div>`,
  });
};
ACT.tabMem = v => { S.tabs.mem = v; render(); };
ACT.memFlip = id => { const m = S.mems.find(x => x.id === id); m.on = !m.on; render(); toast(m.on ? '已启用' : '已停用，下一轮起不再带上'); };
ACT.memKeep = id => { const m = S.mems.find(x => x.id === id); m.kind = 'explicit'; m.on = true; m.used = null; render(); snack(`记住了：${m.text}`, () => { m.kind = 'cand'; m.on = false; }, { icon: 'jar' }); };
ACT.memDrop = id => { S.mems = S.mems.filter(x => x.id !== id); render(); toast('好，不记这条'); };
SHEETS.mem = ({ id }) => {
  const m = S.mems.find(x => x.id === id);
  return sheet('记忆', `
    <textarea class="field" rows="2" id="mem-in" data-bind="flags.memEdit">${esc(m.text)}</textarea>
    <button class="opt" data-act="toast" data-arg="原型：跳到这条记忆来源的那句话">${ic('chat', 'sm')}<span class="t"><b>${esc(m.src)}</b></span>${ic('right', 'sm')}</button>`,
  { foot: `<button class="ibtn" data-act="memDel" data-arg="${id}" aria-label="删除" style="color:var(--c-red-ink)">${ic('trash')}</button><button class="btn ghost grow" data-act="memFlip2" data-arg="${id}">${m.on ? '停用' : '启用'}</button><button class="btn pri grow" data-act="memSave" data-arg="${id}">保存</button>` });
};
ACT.memFlip2 = id => { const m = S.mems.find(x => x.id === id); m.on = !m.on; S.sheet = null; render(); };
ACT.memSave = id => { const m = S.mems.find(x => x.id === id); if (S.flags.memEdit) m.text = S.flags.memEdit; S.flags.memEdit = ''; S.sheet = null; render(); toast('已保存'); };
ACT.memDel = id => { S.mems = S.mems.filter(x => x.id !== id); S.sheet = null; render(); toast('已删除，不会随备份复活'); };
ACT.memYes = mid => { const [m] = findMsg(mid); m.state = 'yes'; S.mems.unshift({ id: uid('m'), scope: S.mode, text: m.text, kind: 'explicit', src: '今天的对话', on: true }); render(); };
ACT.memNo = mid => { const [m] = findMsg(mid); m.state = 'no'; render(); };
ACT.undoSaved = mid => {
  const [m] = findMsg(mid);
  m.undone = true;
  if (m.what === 'note' || m.kind === 'confirm') dropNote(m.ref);
  if (m.what === 'rem') S.rems = S.rems.filter(r => r.id !== m.ref);
  if (m.what === 'mem') S.mems = S.mems.filter(x => x.id !== m.ref);
  render(); toast('已撤销');
};
ACT.confirmYes = mid => { const [m] = findMsg(mid); m.state = 'yes'; m.ref = addNote(m.quote, '对话里你确认后记下').id; render(); };
ACT.confirmNo = mid => { const [m] = findMsg(mid); m.state = 'no'; render(); };

/* ================= 人格与风格 ================= */
const TONES = {
  warm: ['亲切', c => `${c ? `${c}，` : ''}周六下午去滨江走走挺合适的，那天多云不下雨。要不要我帮你排个时间？`],
  brief: ['简练', () => '周六下午，滨江。要排时间表吗？'],
  pro: ['专业', () => '建议周六 14:00–17:00 前往滨江步道：当日多云，无降水。是否需要我给出时间安排？'],
  playful: ['俏皮', c => `${c ? `${c}～` : ''}周六的太阳在等你，滨江走起！要我顺手排个时间表不？`],
};
SCREENS.persona = () => {
  const p = S.set.persona;
  return page({
    title: '人格与风格',
    body: `<div class="pb">
      <div class="form">
        <label><span>名字</span><input class="field" id="p-name" value="${esc(p.name)}" data-bind="set.persona.name" data-live maxlength="8"></label>
        <label><span>怎么称呼你</span><input class="field" id="p-call" value="${esc(p.call)}" data-bind="set.persona.call" data-live maxlength="8"></label>
        <div><span>语气</span><div class="chips wrap">${Object.entries(TONES).map(([k, [label]]) => `<button class="chip${p.tone === k ? ' on' : ''}" data-act="setv" data-arg="set.persona.tone=${k}">${label}</button>`).join('')}</div></div>
        <div><span>详略</span>${seg([['0', '简洁'], ['1', '适中'], ['2', '详细']], String(p.verbose), 'setVerbose')}</div>
        <label><span>补充说明</span><textarea class="field" rows="2" id="p-custom" placeholder="比如：少用感叹号" data-bind="set.persona.custom" maxlength="300">${esc(p.custom)}</textarea></label>
      </div>
      ${sec('预览')}
      <div class="card preview" style="margin:0 14px"><div class="md"><p>${esc(TONES[p.tone][1](p.call))}</p></div>
        <div class="fixed-line" title="状态文案不随语气变">${ic('lock', 'xs')}${badge('电脑已收到，等待执行', 'blue')}</div></div>
      ${spaced(group([row({ icon: 'sun', tone: 'amber', title: '让助手写问候', right: tg(p.aiGreet, 'flip', 'set.persona.aiGreet', '让助手写问候') })]))}
    </div>`,
  });
};
ACT.setVerbose = v => { S.set.persona.verbose = +v; render(); };

/* ================= 权限 ================= */
SCREENS.perms = () => {
  const toolRow = ([k, d]) => row({
    icon: d.icon, tone: S.set.tools[k] && !d.pending ? '' : 'gray', title: d.label,
    right: `${d.pending ? '<small>数据源未定</small>' : ''}${tg(S.set.tools[k] && !d.pending, 'flip', `set.tools.${k}`, d.label, d.pending)}`,
  });
  const mine = (icon, title) => row({ icon, tone: 'gray', title });
  return page({
    title: '权限',
    body: `<div class="pb">
      ${TOOL_GROUPS.map(([g, label]) => sec(label) + group(Object.entries(TOOLS).filter(([, d]) => d.g === g).map(toolRow))).join('')}
      ${sec('系统权限')}${group(Object.entries(SYSPERM).map(([k, label]) => { const st = PERM_STATE[S.set.sys[k]]; return row({ title: label, right: badge(st.label, st.tone, false), act: 'toast', arg: '原型：跳到系统的应用权限页', chev: false }); }))}
      ${sec('始终由你决定')}${group([mine('trash', '删除'), mine('monitor', '交给电脑'), mine('shield', '读过外部内容后的写入')])}
    </div>`,
  });
};

/* ================= 设置 ================= */
SCREENS.settings = () => {
  const p = S.set.persona;
  const nav = (icon, title, to, val = '', tone = '') => row({ icon, tone, title, right: val, act: 'go', arg: to });
  return page({
    title: '设置',
    body: `<div class="pb">
      <button class="profile" data-act="go" data-arg="persona">${Pet.html('idle', 1, 'profile')}<span><b>${esc(p.name)}</b></span>${ic('right', 'sm')}</button>
      ${sec('助手')}${group([
        nav('key', '模型', 'model', MODELS[S.set.model].short),
        nav('smile', '人格', 'persona', TONES[p.tone][0]),
        nav('jar', '记忆', 'memory', String(S.mems.filter(x => x.on).length)),
        nav('shield', '权限', 'perms'),
      ])}
      ${sec('生活')}${group([
        nav('alarm', '提醒', 'reminders', String(S.rems.filter(r => r.on).length), 'blue'),
        row({ icon: 'rain', tone: 'blue', title: '天气', right: esc(S.set.city), act: 'sheet', arg: 'weather' }),
        row({ icon: 'sun', tone: 'amber', title: '每日简报', right: tg(S.set.brief, 'flip', 'set.brief', '每日简报') }),
      ])}
      ${sec('工作')}${group([
        nav('monitor', '电脑', 'computers', `${onlineCount()}/${Object.keys(S.computers).length}`),
        nav('tree', '项目与 Agent', 'projects', String(Object.keys(PROJECTS).length)),
      ])}
      ${sec('数据')}${group([
        nav('bell', '通知', 'notify'),
        nav('coin', '用量', 'usage', `≈¥${USAGE.today.toFixed(2)}`),
        nav('db', '存储', 'storage', '208 MB'),
        nav('lock', '应用锁与备份', 'privacy'),
      ])}
      ${spaced(group([nav('spark', '小引', 'pet')]))}
      <div class="hint center">设计原型 · 内容都是示例</div></div>`,
  });
};

SCREENS.model = () => {
  const m = MODELS[S.set.model], off = S.set.provider === 'official';
  const cap = v => (v === 1 ? badge('可用', 'green', false) : v === 0 ? badge('不可用', 'red', false) : badge('未验证', 'gray', false));
  const pick = on => (on ? ic('check') : '');
  return page({
    title: '模型与 Key',
    body: `<div class="pb">${sec('接入')}${group([
        row({ icon: 'key', title: 'DeepSeek 官方', right: `${off ? '<small>Key ••••</small>' : ''}${pick(off)}`, act: 'setv', arg: 'set.provider=official', chev: false }),
        row({ icon: 'link', tone: 'gray', title: '自定义网关', right: pick(!off), act: 'setv', arg: 'set.provider=custom', chev: false }),
      ])}
      ${sec('模型')}${group(Object.entries(MODELS).filter(([k]) => (off ? k !== 'custom' : true)).map(([k, d]) => row({ title: `${d.name}${d.api ? ` <span class="tag">${d.api}</span>` : ''}`, right: pick(S.set.model === k), act: 'setv', arg: `set.model=${k}`, chev: false })))}
      ${sec('思考强度')}<div class="seg-wrap">${seg(Object.entries(THINK), S.set.think, 'setThink')}</div>
      ${sec(`${m.name} 能做什么`)}
      <div class="card" style="margin:0 14px"><div class="caps">${Object.entries(m.caps).map(([k, v]) => `<span>${k}${cap(off || k === '流式' ? v : -1)}</span>`).join('')}</div></div>
      ${sec('联网搜索')}${group([
        row({ icon: 'search', title: '官方搜索', right: pick(S.set.search === 'official'), act: 'setv', arg: 'set.search=official', chev: false }),
        row({ icon: 'globe', tone: 'gray', title: 'Brave Search', right: pick(S.set.search === 'brave'), act: 'setv', arg: 'set.search=brave', chev: false }),
      ])}
      ${spaced(group([row({ icon: 'layers', title: '上下文预算', right: `${S.set.budget / 10000} 万`, act: 'toast', arg: '原型：调整上下文预算' })]))}</div>`,
  });
};

SCREENS.usage = () => {
  const max = Math.max(...USAGE.days.map(d => d[1]));
  return page({
    title: '用量与花费',
    body: `<div class="pb"><div class="money-hero">${em('usage', 64)}<div><small>今天</small><b>≈¥${USAGE.today.toFixed(2)}</b></div><div><small>本月</small><b>≈¥${USAGE.month.toFixed(2)}</b></div></div>
      <div class="card" style="margin:0 14px"><div class="bars">${USAGE.days.map(([d, v], i) => `<div class="${i === 6 ? 'cur' : ''}"><i style="height:${Math.round(v / max * 72) + 4}px"></i><b>${v.toFixed(2)}</b><small>${d}</small></div>`).join('')}</div></div>
      ${sec('今天')}
      <div class="card" style="margin:0 14px"><dl class="kv money">${USAGE.parts.map(([k, v]) => `<dt>${k}</dt><dd><span><i class="pbar" style="width:${Math.round(v / USAGE.today * 100)}%"></i></span><b>¥${v.toFixed(2)}</b></dd>`).join('')}</dl></div>
      ${spaced(group([
        row({ icon: 'bell', title: '每日提醒', right: `¥${S.set.dayLimit}`, act: 'toast', arg: '原型：调整每日提醒阈值' }),
        row({ icon: 'layers', title: '上下文预算', right: `${S.set.budget / 10000} 万`, act: 'toast', arg: '原型：调整上下文预算' }),
      ]))}
      ${sec('单价', `<button data-act="toast" data-arg="原型：按官方页面更新单价">${PRICE.checked}</button>`)}
      <div class="card" style="margin:0 14px"><table class="price"><tr><th>每百万 token</th><th>未命中</th><th>命中</th><th>输出</th></tr>
        <tr><td>V4.1 Flash</td><td>¥${PRICE.flash.miss}</td><td>¥${PRICE.flash.hit}</td><td>¥${PRICE.flash.out}</td></tr><tr><td>V4 Pro</td><td>¥${PRICE.pro.miss}</td><td>¥${PRICE.pro.hit}</td><td>¥${PRICE.pro.out}</td></tr></table></div>
      <div class="hint center">估算，以账单为准</div></div>`,
  });
};

SCREENS.notify = () => {
  const n = S.set.notif;
  const sample = (app, title, text, t) => `<div class="notif"><img src="${A('app-icon-a')}" width="22" height="22" alt=""><div><small>星引 · ${app} · ${t}</small><b>${title}</b><span>${text}</span></div></div>`;
  return page({
    title: '通知',
    body: `<div class="pb" style="padding-top:6px">${group([
      row({ icon: 'alarm', tone: 'blue', title: '提醒', right: tg(n.reminder, 'flip', 'set.notif.reminder', '提醒') }),
      row({ icon: 'rain', tone: 'blue', title: '雨天与预警', right: tg(n.weather, 'flip', 'set.notif.weather', '雨天与预警') }),
      row({ icon: 'monitor', title: '工作事项', right: tg(n.work, 'flip', 'set.notif.work', '工作事项') }),
      row({ icon: 'moon', tone: 'gray', title: '安静时段', right: `<small>22:30–07:30</small>${tg(n.quiet, 'flip', 'set.notif.quiet', '安静时段')}` }),
    ])}
    ${sec('样子')}<div class="notif-list">
      ${sample('提醒', '给妈妈回电话', '19:30', '现在')}
      ${sample('天气', '18:00 后有雨', '上海', '07:30')}
      ${sample('工作', '待验收', `${esc(computerLabel(S.computers.work))} · alcor-web`, '10:31')}</div>
    <div style="padding:14px 14px 0">${box('应用被系统清理后，天气和工作通知<b>可能收不到</b> <button class="btn text" data-act="toast" data-arg="原型：跳到系统的后台运行设置" style="height:20px">去设置</button>', 'amber', 'warn')}</div></div>`,
  });
};

SCREENS.storage = () => {
  const bar = (label, mb, tone) => `<div class="stor"><div><b>${label}</b><span>${mb} MB</span></div><i><u class="tone-${tone}" style="width:${Math.round(mb / 208 * 100)}%"></u></i></div>`;
  return page({
    title: '存储',
    body: `<div class="pb"><div class="card" style="margin:6px 14px 0">${bar('对话与笔记', 18, 'violet')}${bar('附件与录音', 126, 'blue')}${bar('缓存', 64, 'amber')}</div>
      ${spaced(group([
        row({ icon: 'trash', tone: 'amber', title: '清理缓存', right: '64 MB', act: 'toast', arg: '原型：清理缓存' }),
        row({ icon: 'file', tone: 'gray', title: '管理附件', act: 'toast', arg: '原型：附件列表' }),
      ]))}
      ${sec('数据在哪')}${group([
        row({ icon: 'sun', tone: 'amber', title: '生活', right: `${ic('phone', 'sm')}只在手机` }),
        row({ icon: 'brief', title: '挂了项目的对话', right: `${ic('monitor', 'sm')}同步到电脑` }),
      ])}</div>`,
  });
};

SCREENS.privacy = () => page({
  title: '应用锁与备份',
  body: `<div class="pb">${sec('应用锁')}${group([
      row({ img: 'app-lock', title: '应用锁', right: tg(S.set.lock, 'flip', 'set.lock', '应用锁') }),
      row({ icon: 'lock', tone: 'gray', title: '现在锁上', act: S.set.lock ? 'lockNow' : '', chev: false }),
    ])}
    ${sec('备份', `<small class="plain">${ic('key', 'xs')}不含凭据</small>`)}${group([
      row({ img: 'backup', title: '导出备份', act: 'toast', arg: '原型：选择保存位置，导出一个备份文件' }),
      row({ icon: 'import', tone: 'gray', title: '从备份恢复', act: 'sheet', arg: 'restoreBackup' }),
    ])}</div>`,
});
ACT.lockNow = () => { S.locked = true; render(); };
SHEETS.restoreBackup = () => sheet('核对备份', `<p>对话 4 · 笔记 6 · 记忆 3 · 提醒 2（示例）</p><p>保留本机记录，按删除标记同步记忆删除；电脑配对和派工不恢复。</p>`,
  { foot: '<button class="btn pri grow" data-act="toast" data-arg="原型：已合并备份">合并备份</button>' });
ACT.unlock = () => { S.locked = false; render(); toast('已解锁'); };
SCREENS.lock = () => `<div class="page lock"><div class="sky"></div><div class="lock-c">${Pet.html('sleep', 2, 'lock')}<b>已锁定</b><button class="finger" data-act="unlock" aria-label="解锁星引">${ic('finger', 'lg')}</button></div></div>`;
