/* 首页、对话、抽屉、找会话、待处理，以及对话里常用的浮层。 */
'use strict';

/* ================= 首页 ================= */
/* 首页和待处理里的一项：图标表示是谁的事，第二行是状态和时间。 */
function evItem(e) {
  const t = e.task && S.tasks[e.task];
  const img = e.type === 'done' ? 'receipt' : t ? EXEC[t.exec].img : e.exec ? EXEC[e.exec].img : { reminder: 'reminder', weather: 'weather-rain' }[e.type] || 'receipt';
  const label = e.type === 'question' ? '等你回答' : EVT[e.type].label;
  return `<button class="item tone-${EVT[e.type].tone}" data-act="openEvent" data-arg="${e.id}">${em(img, 42)}<span class="item-t"><b>${esc(e.title)}</b><small><em>${label}</em> · ${esc(e.time)}</small></span>${e.unread ? '<i class="unread"></i>' : ic('right', 'sm')}</button>`;
}
function taskItem(t) {
  const s = STAGE[t.stage];
  return `<button class="item tone-${s.tone}" data-act="go" data-arg="receipt:${t.id}">${em(EXEC[t.exec].img, 42)}<span class="item-t"><b>${esc(t.title)}</b><small><em>${s.label}</em></small></span>${ic('right', 'sm')}</button>`;
}
function agendaItems() {
  const out = [];
  if (S.flags.first) {
    const t = (img, label, action, value) => `<button class="tl" data-act="${action}" data-arg="${value}">${em(img, 48)}<b>${label}</b></button>`;
    return [`<div class="card welcome"><b>我是${esc(S.set.persona.name)}，直接说就行</b><div class="tiles c3">${t('note', '随手记', 'sheet', 'capture')}${t('phone-assistant', '接着聊', 'sheet', 'setup')}${t('handoff', '交给电脑', 'go', 'computers')}</div></div>`];
  }
  if (!S.net) out.push(`<div class="item tone-amber">${em('offline-phone', 42)}<span class="item-t"><b>没有网络</b><small>能看、能记、能存草稿</small></span></div>`);
  if (S.mode === 'work') {
    openEvents('work').forEach(e => out.push(evItem(e)));
    liveTasks().filter(t => !S.events.some(e => e.task === t.id && e.open)).forEach(t => out.push(taskItem(t)));
    const last = Object.values(S.convs).filter(c => c.mode === 'work' && c.kind === 'chat').sort((a, b) => b.used - a.used)[0];
    if (last && out.length < 3) out.push(`<button class="item" data-act="openConv" data-arg="${last.id}">${em('decision', 42)}<span class="item-t"><b>${esc(last.title)}</b><small><em>继续上次</em> · ${esc(last.time)}</small></span>${ic('right', 'sm')}</button>`);
  } else {
    S.events.filter(e => e.mode === 'life' && e.unread).forEach(e => out.push(evItem(e)));
    const r = S.rems.find(x => x.mode === 'life' && x.on && x.when.startsWith('今天'));
    if (r) out.push(`<button class="item tone-blue" data-act="go" data-arg="reminders">${em('reminder', 42)}<span class="item-t"><b>${esc(r.text)}</b><small><em>提醒</em> · ${esc(r.when)}</small></span>${ic('right', 'sm')}</button>`);
    const inbox = S.notes.filter(n => n.mode === 'life' && n.box === 'inbox');
    if (inbox.length) out.push(`<button class="item" data-act="go" data-arg="notes">${em('note', 42)}<span class="item-t"><b>${esc(noteTitle(inbox[0]))}</b><small><em>收件箱 ${inbox.length} 条</em></small></span>${ic('right', 'sm')}</button>`);
  }
  return out;
}
function homeSubline() {
  if (!S.net) return '';
  if (!S.ready) return `<button data-act="sheet" data-arg="setup">${ic('key', 'xs')}接入 DeepSeek</button>`;
  if (S.mode === 'life') return `<button data-act="sheet" data-arg="weather" aria-label="${WX.city} ${WX.temp} 度，${WX.rainAt} 后有雨">${ic('cloud', 'xs')}${WX.temp}°　${ic('umbrella', 'xs')}${WX.rainAt}</button>`;
  const all = Object.values(S.computers), on = all.filter(c => c.online);
  return `<button data-act="go" data-arg="computers" aria-label="电脑 ${on.length}/${all.length} 在线"><i class="dot ${on.length ? 'on' : 'off'}"></i>${ic('monitor', 'xs')}${on.length}/${all.length}</button>`;
}
function heroHTML(compact) {
  const pet = S.set.pet.show ? `<span class="pet-wrap">${Pet.html(petNow(), compact ? 1 : 2)}</span>` : `<img class="em" src="${A('app-icon-a')}" width="${compact ? 40 : 72}" height="${compact ? 40 : 72}" style="border-radius:24%;margin:${compact ? '6px 4px 6px 6px' : '18px 0 6px'}" alt="">`;
  if (compact) return `<div class="hero compact">${pet}<div class="hero-t"><b class="greet">${esc(greeting())}</b>${petCap()}</div></div>`;
  return `<div class="hero">${pet}${petCap()}<h1 class="greet">${esc(greeting())}</h1><div class="subline">${homeSubline()}</div></div>`;
}
const HOME_SUGG = {
  work: ['接着聊昨天登录页那个方案', '各项目现在到哪了', '帮我起草周报的开头'],
  life: ['这周末上海适合去哪儿走走？', '明早 8 点半提醒我带伞', '附近有什么好吃的'],
};
SCREENS.home = () => {
  const id = homeId(), c = S.convs[id], has = c.msgs.length > 0, life = S.mode === 'life', other = life ? 'work' : 'life';
  const otherBusy = S.events.some(e => e.mode === other && (e.open || e.unread)) || (other === 'work' && liveTasks().length > 0);
  const pip = otherBusy ? '<i class="pip"></i>' : '';
  const n = unreadCount(S.mode);
  const sugg = S.sugg || HOME_SUGG[S.mode];
  return `<div class="page home ${S.enter}"><div class="sky"></div>
    <div class="bar"><button class="ib" data-act="drawer" aria-label="菜单">${ic('menu')}</button>
      <div class="mode-sw" role="tablist" aria-label="模式">
        <button class="${life ? 'on' : ''}" data-act="mode" data-arg="life" role="tab" aria-selected="${life}">${ic('sun', 'xs')}生活${life ? '' : pip}</button>
        <button class="${life ? '' : 'on'}" data-act="mode" data-arg="work" role="tab" aria-selected="${!life}">${ic('brief', 'xs')}工作${life ? pip : ''}</button>
      </div>
      <button class="ib" data-act="go" data-arg="inbox" aria-label="${n ? '待处理，' + n + ' 条未读' : '待处理'}">${ic('bell')}${n ? `<span class="badge" aria-hidden="true">${n}</span>` : ''}</button></div>
    ${has ? heroHTML(true) : ''}
    <div class="scroll" data-scroll="home" ${has ? 'data-stick' : ''}>
      ${has ? `<div class="stream">${c.msgs.map(m => renderMsg(m, id)).join('')}</div>` : `${heroHTML(false)}<div class="agenda">${agendaItems().join('')}</div>`}
    </div>
    <div class="dock">${has && !S.sugg ? '' : `<div class="sugg">${sugg.map(s => `<button class="chip" data-act="fill" data-arg="${esc(s)}">${esc(s)}</button>`).join('')}</div>`}
      ${composer(id, life ? '想到什么，直接说' : '说说要做的事')}</div></div>`;
};
ACT.openEvent = id => {
  const e = S.events.find(x => x.id === id);
  if (!e) return;
  e.unread = false; // 点开即已读；是否还留在待处理由 open 决定
  if (e.task) return go('receipt', { id: e.task });
  if (e.conv) return ACT.openConv(e.conv);
  if (e.type === 'weather') return openSheet('weather');
  if (e.type === 'reminder') return go('reminders');
  render();
};

/* ================= 对话 ================= */
SCREENS.chat = ({ id }) => {
  const c = S.convs[id], p = c.project && PROJECTS[c.project], dev = p && S.computers[p.device];
  const native = c.kind === 'codex' || c.kind === 'dsh';
  const sub = native ? `<span class="tag ${c.kind}">${KIND[c.kind].label}</span>${p.name}`
    : p ? `<i class="dot ${dev.online ? 'on' : 'off'}"></i>${p.name} · ${esc(computerLabel(dev))}`
      : `${ic('phone', 'xs')}只在手机`;
  const canAttach = c.mode === 'work' && !p && !native && c.msgs.length > 0;
  const right = `${canAttach ? `<button class="btn soft sm" data-act="sheet" data-arg="attachproj">挂到项目</button>` : ''}<button class="ib" data-act="sheet" data-arg="chatmenu" aria-label="更多">${ic('more')}</button>`;
  const empty = `<div class="empty">${em(c.mode === 'life' ? 'mode-life' : 'phone-assistant', 88)}<b>新对话</b></div>`;
  const sugg = S.sugg ? `<div class="sugg">${S.sugg.map(s => `<button class="chip" data-act="fill" data-arg="${esc(s)}">${esc(s)}</button>`).join('')}</div>` : '';
  return page({
    title: esc(c.title), sub, right, key: `chat:${id}`, cls: 'chat',
    body: c.msgs.length ? `<div class="stream">${c.msgs.map(m => renderMsg(m, id)).join('')}</div>` : empty,
    dock: `<div class="dock">${sugg}${composer(id, native ? '续聊请交给原窗口' : '想聊什么，直接说')}</div>`,
  }).replace('data-scroll=', 'data-stick data-scroll=');
};

/* ================= 抽屉 ================= */
function drawerHTML() {
  const mode = S.mode, life = mode === 'life';
  const convs = Object.values(S.convs).filter(c => c.mode === mode && c.kind !== 'mgr').sort((a, b) => b.used - a.used).slice(0, 5);
  const inboxN = S.notes.filter(n => n.mode === mode && n.box === 'inbox').length;
  const remN = S.rems.filter(r => r.mode === mode && r.on).length;
  const memN = S.mems.filter(m => m.on && (life ? m.scope === 'life' : m.scope !== 'life')).length;
  const projN = Object.keys(PROJECTS).length;
  const nav = (icon, label, right, to) => `<button class="dr-row" data-act="go" data-arg="${to}">${ic(icon)}<b>${label}</b><small>${right}</small></button>`;
  return `<aside class="drawer">
    <button class="searchbox" data-act="go" data-arg="sessions">${ic('search', 'sm')}<span>搜对话和笔记</span></button>
    <div class="dr-new"><button class="btn pri grow" data-act="newChat">${ic('newchat', 'sm')}新对话</button><button class="btn soft grow" data-act="sheet" data-arg="capture">${ic('pen', 'sm')}记一笔</button></div>
    <div class="scroll" data-scroll="drawer">
      <div class="dr-nav">
        ${nav('note', '笔记', inboxN ? `收件箱 ${inboxN}` : '', 'notes')}
        ${nav('alarm', '提醒', remN ? `${remN} 个待提醒` : '', 'reminders')}
        ${nav('jar', '记忆', `${memN} 条在用`, 'memory')}
        ${life ? '' : nav('tree', '项目与 Agent', `${projN} 个项目`, 'projects') + nav('monitor', '电脑', `${onlineCount()}/${Object.keys(S.computers).length} 在线`, 'computers')}
      </div>
      ${sec(`${life ? '生活' : '工作'}里的对话`, `<button data-act="go" data-arg="sessions">全部</button>`)}
      <div class="dr-convs">
        <button class="dr-conv" data-act="openConv" data-arg="${homeId()}">${ic('spark', 'sm')}<b>总管对话</b><small>首页</small></button>
        ${convs.map(c => `<button class="dr-conv" data-act="openConv" data-arg="${c.id}">${ic(c.kind === 'chat' ? 'chat' : 'monitor', 'sm')}<b>${esc(c.title)}</b><small>${c.kind === 'chat' ? esc(c.time) : KIND[c.kind].label}</small></button>`).join('')}
      </div>
    </div>
    <button class="dr-foot" data-act="go" data-arg="settings">${Pet.html('idle', 1, 'drawer')}<span><b>${esc(S.set.persona.name)}</b><small>设置</small></span>${ic('sliders')}</button>
  </aside>`;
}

/* ================= 找会话 ================= */
SCREENS.sessions = () => {
  const life = S.mode === 'life', q = S.q.trim();
  const list = Object.values(S.convs).filter(c => c.mode === S.mode).filter(c => !q || (c.title + (c.recent || '') + (c.project || '')).includes(q));
  const tab = life ? 'recent' : S.tabs.sessions;
  let body = '';
  if (tab === 'recent') {
    body = group([...list].sort((a, b) => b.used - a.used).map(convRow));
  } else if (tab === 'project') {
    body = [...Object.keys(PROJECTS), ''].map(k => {
      const rows = list.filter(c => (c.project || '') === k && c.kind !== 'mgr');
      if (!rows.length) return '';
      const p = PROJECTS[k];
      return sec(p ? `${esc(p.name)} <small class="plain">${esc(computerLabel(S.computers[p.device]))}</small>` : '只在手机') + group(rows.map(convRow));
    }).join('');
  } else {
    body = ['mgr', 'chat', 'codex', 'dsh'].map(k => {
      const rows = list.filter(c => c.kind === k);
      return rows.length ? sec(k === 'mgr' ? '总管' : k === 'chat' ? '对话' : KIND[k].label) + group(rows.map(convRow)) : '';
    }).join('');
  }
  const notes = q ? S.notes.filter(n => n.mode === S.mode && noteTitle(n).includes(q)) : [];
  if (notes.length) body += sec('笔记') + group(notes.map(n => row({ icon: 'note', title: esc(noteTitle(n)), act: 'go', arg: `note:${n.id}`, cls: 'one', chev: false })));
  if (!list.length && !notes.length) body = `<div class="empty">${em('find-sessions', 88)}<b>没有找到</b></div>`;
  return page({
    title: '找会话',
    head: `<label class="searchbox" style="margin-bottom:10px">${ic('search', 'sm')}<input placeholder="搜对话和笔记" value="${esc(S.q)}" data-bind="q" data-live id="q-in"></label>${life ? '' : `<div class="seg-wrap">${seg([['recent', '最近'], ['project', '项目'], ['kind', '分类']], tab, 'tabSessions')}</div>`}`,
    body: `<div class="pb">${body}</div>`,
  });
};
ACT.tabSessions = v => { S.tabs.sessions = v; render(); };

/* ================= 待处理 ================= */
SCREENS.inbox = () => {
  const evs = S.events.filter(e => e.mode === S.mode);
  const todo = evs.filter(e => e.open);
  const running = S.mode === 'work' ? liveTasks().filter(t => !S.events.some(e => e.task === t.id && e.open)) : [];
  const rest = evs.filter(e => !e.open);
  const list = xs => `<div class="agenda" style="padding-top:0">${xs.join('')}</div>`;
  const body = !todo.length && !running.length && !rest.length
    ? `<div class="empty">${em('all-clear', 96)}<b>都处理完了</b></div>`
    : `${todo.length ? sec('等你处理') + list(todo.map(evItem)) : ''}${running.length ? sec('进行中') + list(running.map(taskItem)) : ''}${rest.length ? sec('通知') + list(rest.map(evItem)) : ''}`;
  return page({
    title: '待处理',
    right: `<button class="ib" data-act="go" data-arg="notify" aria-label="通知设置">${ic('sliders')}</button>`,
    body: `<div class="pb">${body}</div>`,
  });
};

/* ================= 对话里的浮层 ================= */
SHEETS.attach = () => sheet('添加', `${tiles([
  { img: 'camera-ask', label: '拍照', act: 'addMat', arg: 'camera' },
  { img: 'album', label: '相册', act: 'addMat', arg: 'photo' },
  { img: 'link-read', label: '文件', act: 'addMat', arg: 'file' },
  { img: 'note', label: '笔记', act: 'addMat', arg: 'note' },
  S.mode === 'life' ? { img: 'all-clear', label: '整理照片', act: 'addMat', arg: 'tidy' } : { img: 'find-sessions', label: '会话摘录', act: 'addMat', arg: 'excerpt' },
], 5)}<div class="hint center">${ic('lock', 'xs')}发送后才离开手机</div>`);
ACT.addMat = kind => {
  const key = curConvId();
  if (kind === 'camera') { S.sheet = null; return go('camera'); }
  if (kind === 'tidy') { S.sheet = null; S.flags.albumConv = key; S.flags.albumN = 24; pushMsg(key, { role: 'user', text: '帮我整理一下这批照片', time: now() }); return go('albumpick'); }
  const m = { photo: { icon: 'image', label: '照片 2 张' }, file: { icon: 'file', label: '会议纪要.md' }, note: { icon: 'note', label: '笔记 1 条' }, excerpt: { icon: 'monitor', label: 'Codex 摘录 2 段' } }[kind];
  (S.mats[key] = S.mats[key] || []).push(m);
  S.sheet = null;
  render();
  toast('已放进本轮材料；发送后才离开手机');
};
SHEETS.model = () => sheet('模型', `
  ${Object.entries(MODELS).map(([k, d]) => `<button class="opt${S.set.model === k ? ' on' : ''}" data-act="setv" data-arg="set.model=${k}"><span class="t"><b>${d.name}</b></span>${S.set.model === k ? ic('check', 'sm') : ''}</button>`).join('')}
  <div class="seg-lab">思考强度</div>${seg(Object.entries(THINK), S.set.think, 'setThink')}
  <button class="btn text" data-act="go" data-arg="model">更多设置 ›</button>`);
ACT.setThink = v => { S.set.think = v; render(); };
SHEETS.setup = () => sheet('接入 DeepSeek', `${hero('phone-assistant')}
  ${seg([['official', 'DeepSeek 官方'], ['custom', '自定义网关']], S.set.provider, 'setProvider')}
  <input class="field" type="password" id="key-in" placeholder="粘贴 API Key" autocomplete="off">
  ${S.set.provider === 'custom' ? '<input class="field" placeholder="HTTPS 地址"><input class="field" placeholder="模型名">' : ''}
  <div class="hint center">${ic('lock', 'xs')}Key 只加密存在这台手机上</div>`,
  { foot: `<button class="btn pri block" data-act="saveKey">保存并发送</button>` });
ACT.setProvider = v => { S.set.provider = v; render(); };
ACT.saveKey = async () => {
  S.ready = true; S.sheet = null;
  const pend = S.pending;
  S.pending = null;
  render();
  toast('已接入。刚才那句话接着发出');
  if (pend) await ACT.sendDraft(pend);
};
SHEETS.usage = ({ id }) => {
  const [m] = findMsg(id);
  const u = m.usage, p = PRICE[u.model || 'flash'];
  const line = (k, n, c) => `<dt>${k}</dt><dd><span>${n}</span><b>${yuan(c)}</b></dd>`;
  return sheet('这一轮', `<div class="card"><dl class="kv money">
      ${line('命中缓存', `${kfmt(u.hit)} token`, u.hit * p.hit / 1e6)}
      ${line('未命中', `${kfmt(u.miss)} token`, u.miss * p.miss / 1e6)}
      ${line('输出', `${kfmt(u.out)} token`, u.out * p.out / 1e6)}
      ${u.think ? line('思考', `${kfmt(u.think)} token`, u.think * p.out / 1e6) : ''}
      ${u.search ? line('搜索', `${u.search} 次`, u.search * PRICE.search) : ''}
      ${u.fetch ? line('读链接', `${u.fetch} 次`, u.fetch * PRICE.fetch) : ''}
      <dt class="sum">合计</dt><dd class="sum"><span></span><b>≈${yuan(costOf(u))}</b></dd></dl></div>
    <div class="card"><dl class="kv money"><dt>今天</dt><dd><span></span><b>≈¥${USAGE.today.toFixed(2)}</b></dd><dt>本月</dt><dd><span></span><b>≈¥${USAGE.month.toFixed(2)}</b></dd></dl></div>
    <div class="hint center">估算，以账单为准</div>`);
};
SHEETS.memused = ({ id }) => {
  const [m] = findMsg(id);
  const items = m.mems.map(k => S.mems.find(x => x.id === k)).filter(Boolean);
  return sheet('用到的记忆', group(items.map(x => row({ icon: 'jar', title: esc(x.text), act: 'go', arg: 'memory' }))));
};
SHEETS.export = () => sheet('导出', tiles([
  { icon: 'file', label: '存为文件', act: 'toast', arg: '原型：打开系统的「保存到」面板' },
  { icon: 'share', label: '分享', act: 'toast', arg: '原型：打开系统分享面板' },
  { icon: 'copy', label: '复制', act: 'toast', arg: '已复制导出内容（含出处）' },
], 3));
SHEETS.chatmenu = () => {
  const c = S.convs[curConvId()], canAttach = c.mode === 'work' && !c.project && c.kind === 'chat';
  return sheet(esc(c.title), group([
    row({ icon: 'pen', title: '改名', act: 'toast', arg: '原型：改名', chev: false }),
    canAttach ? row({ icon: 'folder', title: '挂到项目', act: 'sheet', arg: 'attachproj', chev: false }) : '',
    row({ icon: 'layers', title: '压缩到这里', act: 'compactNow', chev: false }),
    row({ icon: 'newchat', title: '带摘要开新对话', act: 'toast', arg: '原型：带着摘要开一场新对话', chev: false }),
    row({ icon: 'export', title: '导出', act: 'toast', arg: '原型：导出整场对话', chev: false }),
    row({ icon: 'trash', tone: 'red', title: '删除', act: 'toast', arg: '原型：删除前会再问一次', chev: false }),
  ]));
};
ACT.compactNow = () => {
  const c = S.convs[curConvId()];
  const n = c.msgs.filter(m => !m.kind).length;
  if (n < 2 || c.msgs.some(m => m.kind === 'summary')) { S.sheet = null; render(); return toast('这场对话还不需要压缩'); }
  c.msgs.splice(0, c.msgs.length, { kind: 'summary', n, ver: 1, points: ['已定：云主机只搬运密文，钥匙只在手机和电脑手里', '未定：要不要画成一张图'] }, ...c.msgs.slice(-1));
  S.sheet = null; render();
  toast('已整理成前情摘要；原文都在，可随时查看');
};
SHEETS.summary = ({ id }) => {
  const m = S.convs[id].msgs.find(x => x.kind === 'summary');
  return sheet('前情摘要', `<div class="card"><div class="n-label">${ic('layers', 'xs')}第 1–${m.n} 条 · 第 ${m.ver} 版</div><div class="md"><ul>${m.points.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div></div>`,
    { foot: `<button class="btn ghost block" data-act="toast" data-arg="原型：展开被压缩的 ${m.n} 条原文">${ic('eye', 'sm')}看原文</button>` });
};
SHEETS.attachproj = () => sheet('挂到项目', `
  ${box('之后的消息会同步到那台电脑，<b>之前的不会</b>', 'accent')}
  ${Object.values(S.computers).map(c => `<div class="sec" style="padding:6px 4px 0"><span>${esc(computerLabel(c))}</span><small class="plain">${c.online ? '在线' : '离线'}</small></div>`
    + group(Object.values(PROJECTS).filter(p => p.device === c.id).map(p => row({ icon: 'folder', title: esc(p.name), act: 'attachTo', arg: p.id, chev: false })))).join('')}`);
ACT.attachTo = pid => {
  const c = S.convs[curConvId()], p = PROJECTS[pid];
  c.project = pid;
  pushMsg(c.id, { kind: 'sys', text: `已挂到 ${p.name} · ${computerLabel(S.computers[p.device])}。之后的消息会同步，之前的不会` });
  S.sheet = null;
  if (S.flags.afterAttach) S.flags.afterAttach(c);
  render();
  toast('挂好了。现在可以把明确的工作交给电脑');
};
