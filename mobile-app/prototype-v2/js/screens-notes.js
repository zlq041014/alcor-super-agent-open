/* 记一笔：快速记录、语音、收件箱、笔记详情，以及把笔记用起来。保存只写本机，不发网络请求，不调用模型。 */
'use strict';
const noteTitle = n => n.text && !n.link ? n.text : n.link ? n.link.title : n.audio ? (n.audio.text ? n.audio.text.slice(0, 22) : `语音 ${n.audio.len}`) : '（空）';
const noteText = n => [n.text, n.link && n.link.title, n.audio && n.audio.text, n.derive && (n.derive.tags || []).join(' ')].filter(Boolean).join(' ');
function addNote(text, via, extra = {}) {
  const n = { id: uid('n'), mode: S.flags.capMode || S.mode, text, time: `今天 ${S.clock}`, via, box: 'inbox', ...extra };
  S.notes.unshift(n);
  return n;
}
const dropNote = id => { S.notes = S.notes.filter(n => n.id !== id); };

/* 从哪个入口记的，用一个小图标表示。 */
const VIA_ICON = { 主屏幕小组件: 'grid', 图标快捷方式: 'grid', 语音: 'mic', 分享自浏览器: 'share', 拍照: 'camera', 对话里记下: 'chat', 对话里你确认后记下: 'chat', 应用内: 'pen' };
const noteMeta = n => `<span title="${esc(n.via)}">${ic(VIA_ICON[n.via] || 'pen', 'xs')}${esc(n.time)}</span>`;
function audioHTML(n) {
  const a = n.audio;
  const bars = [5, 9, 14, 8, 12, 16, 7, 10, 13, 6, 9, 12, 5, 8, 11, 6, 10, 7].map(h => `<i style="height:${h}px"></i>`).join('');
  const state = a.state === 'done' ? `<p class="n-text">${esc(a.text)}</p>`
    : a.state === 'failed' ? `<small class="n-sub warn">${ic('warn', 'xs')}转写失败<button class="btn text" data-act="retryAsr" data-arg="${n.id}">重试</button></small>`
      : a.state === 'wait' ? `<small class="n-sub">${ic('clock', 'xs')}联网后转文字</small>`
        : `<small class="n-sub">${ic('refresh', 'xs spin')}转文字中</small>`;
  return `<div class="audio"><button class="a-play" data-act="toast" data-arg="原型：播放这段录音" aria-label="播放">${ic('play', 'sm fill')}</button><span class="wavebars">${bars}</span><time>${a.len}</time></div>${state}`;
}
function noteCard(n) {
  const picking = !!S.flags.noteSel, sel = picking && S.flags.noteSel.has(n.id);
  const text = n.text && !n.link ? `<p class="n-text">${esc(n.text)}</p>` : '';
  const link = n.link ? `<div class="n-link">${ic('link', 'sm')}<span><b>${esc(n.link.title)}</b><small>${esc(n.link.host)}</small></span></div>` : '';
  const img = n.img ? `<div class="n-img" title="${esc(n.img)}">${ic('image')}</div>` : '';
  const tags = n.derive && n.derive.tags ? n.derive.tags.map(t => `<i class="n-tag">#${esc(t)}</i>`).join('') : '';
  const marks = `${n.project ? `<span class="chip sm">${ic('folder', 'xs')}${esc(PROJECTS[n.project].name)}</span>` : ''}${n.remind ? `<span class="chip sm">${ic('alarm', 'xs')}${esc(n.remind)}</span>` : ''}`;
  return `<div class="note-card${sel ? ' sel' : ''}" role="button" tabindex="0" data-act="${picking ? 'noteToggle' : 'go'}" data-arg="${picking ? n.id : `note:${n.id}`}">
    ${picking ? `<i class="n-check">${sel ? ic('check', 'xs') : ''}</i>` : ''}${text}${link}${n.audio ? audioHTML(n) : ''}${img}
    <div class="n-meta">${noteMeta(n)}${tags}${marks}</div></div>`;
}

/* ================= 笔记列表 ================= */
SCREENS.notes = () => {
  const tab = S.tabs.notes, q = S.q.trim(), picking = !!S.flags.noteSel;
  const mine = S.notes.filter(n => n.mode === S.mode);
  const list = mine.filter(n => n.box === tab).filter(n => !q || noteText(n).includes(q));
  const cnt = k => mine.filter(n => n.box === k).length;
  const selN = picking ? S.flags.noteSel.size : 0;
  const empty = `<div class="empty">${em(q ? 'find-sessions' : tab === 'inbox' ? 'all-clear' : 'note', 88)}<b>${q ? '没有找到' : tab === 'inbox' ? '收件箱是空的' : '还没有笔记'}</b></div>`;
  const tidy = tab === 'inbox' && list.some(n => !n.derive) && !picking && !q;
  return page({
    title: '笔记',
    right: picking ? `<button class="btn text" data-act="noteSelOff">完成</button>` : `<button class="btn text" data-act="noteSelOn">选择</button>`,
    head: `<label class="searchbox" style="margin-bottom:10px">${ic('search', 'sm')}<input placeholder="搜笔记" value="${esc(S.q)}" data-bind="q" data-live id="q-in"></label>
      <div class="seg-wrap">${seg([['inbox', `收件箱 ${cnt('inbox') || ''}`], ['filed', '已归入'], ['archived', '已归档']], tab, 'tabNotes')}</div>`,
    body: `<div class="note-list">${tidy ? `<button class="chip on tidy-chip" data-act="sheet" data-arg="tidy">${ic('spark', 'xs')}整理收件箱</button>` : ''}${list.length ? list.map(noteCard).join('') : empty}</div>`,
    dock: picking
      ? `<div class="dock selbar"><span>已选 ${selN} 条</span><button class="btn pri sm" data-act="notesToChat" ${selN ? '' : 'disabled'}>${ic('newchat', 'sm')}开对话</button><button class="btn ghost sm" data-act="notesArchive" ${selN ? '' : 'disabled'}>归档</button></div>`
      : `<button class="fab" data-act="sheet" data-arg="capture" aria-label="记一笔">${ic('pen')}<span>记一笔</span></button>`,
  });
};
ACT.tabNotes = v => { S.tabs.notes = v; render(); };
ACT.noteSelOn = () => { S.flags.noteSel = new Set(); render(); };
ACT.noteSelOff = () => { S.flags.noteSel = null; render(); };
ACT.noteToggle = id => { const s = S.flags.noteSel; if (s.has(id)) s.delete(id); else s.add(id); render(); };
ACT.notesArchive = () => { const s = S.flags.noteSel; S.notes.forEach(n => { if (s.has(n.id)) n.box = 'archived'; }); S.flags.noteSel = null; render(); toast('已归档，随时可以找回'); };
function notesIntoChat(ids) {
  const id = uid('x');
  const notes = ids.map(k => S.notes.find(n => n.id === k)).filter(Boolean);
  S.convs[id] = { id, mode: S.mode, kind: 'chat', title: '新对话', time: '刚刚', recent: '', used: 100, msgs: [{ kind: 'sys', text: `带来 ${notes.length} 条笔记，发送后才交给模型` }] };
  S.mats[id] = notes.map(n => ({ icon: 'note', label: noteTitle(n).slice(0, 12), note: n.id }));
  S.flags.noteSel = null;
  go('chat', { id });
}
ACT.notesToChat = () => notesIntoChat([...S.flags.noteSel]);
SHEETS.tidy = () => {
  const n = S.notes.filter(x => x.mode === S.mode && x.box === 'inbox' && !x.derive).length;
  return sheet('整理收件箱', `${hero('note')}
    ${box(`<b>${n} 条笔记会发给模型</b> · ≈¥0.004　原文不改`, 'amber', 'export')}
    ${group([row({ icon: 'refresh', title: '以后自动整理', right: tg(S.set.autoTidy, 'flip', 'set.autoTidy', '以后自动整理') })])}`,
  { foot: `<button class="btn ghost grow" data-act="closeSheet">不用</button><button class="btn pri grow" data-act="tidyRun">整理</button>` });
};
ACT.tidyRun = async () => {
  S.sheet = null; render(); toast('正在整理…');
  await sleep(1200);
  const tags = { work: [['登录页', '文案'], ['周报', '待确认']], life: [['出行', '崇明'], ['家人', '生日'], ['语音']] }[S.mode];
  let i = 0;
  S.notes.forEach(n => { if (n.mode === S.mode && n.box === 'inbox' && !n.derive) { n.derive = { tags: tags[i % tags.length], sum: i === 0 ? (S.mode === 'work' ? '可能和对话「登录页改版」有关。' : '可能和对话「崇明看日出」有关。') : '' }; i++; } });
  render(); toast('整理好了。标签和摘要是另存的一层，原文没动');
};

/* ================= 笔记详情 ================= */
SCREENS.note = ({ id }) => {
  const n = S.notes.find(x => x.id === id);
  if (!n) return page({ title: '笔记', body: '<div class="empty"><b>这条笔记已经不在了</b></div>' });
  const d = n.derive, work = n.mode === 'work';
  const raw = `<div class="card note-raw">
    ${n.text && !n.link ? `<p class="n-big">${esc(n.text)}</p>` : ''}
    ${n.link ? `<div class="n-link big">${ic('link')}<span><b>${esc(n.link.title)}</b><small>${esc(n.text)}</small></span></div>` : ''}
    ${n.audio ? audioHTML(n) : ''}
    ${n.img ? `<div class="n-img big" title="${esc(n.img)}">${ic('image', 'lg')}</div>` : ''}
    <div class="n-meta">${noteMeta(n)}<span class="chip sm">${ic(work ? 'brief' : 'sun', 'xs')}${work ? '工作' : '生活'}</span></div></div>`;
  const derive = d ? `<div class="card"><div class="n-label">${ic('spark', 'xs')}小引整理<button class="ib sm" data-act="noteClear" data-arg="${n.id}" aria-label="清除整理结果" style="margin-left:auto">${ic('x', 'sm')}</button></div>
      <div class="chips wrap">${(d.tags || []).map(t => `<span class="chip sm on">#${esc(t)}</span>`).join('')}</div>
      ${d.sum ? `<p class="n-sum">${esc(d.sum)}</p>` : ''}
      ${d.rel ? `<button class="opt" data-act="openConv" data-arg="d-login">${ic('chat', 'sm')}<span class="t"><b>${esc(d.rel)}</b></span>${ic('right', 'sm')}</button>` : ''}</div>`
    : `<button class="chip on tidy-chip" data-act="noteTidyOne" data-arg="${n.id}">${ic('spark', 'xs')}整理这一条</button>`;
  const use = tiles([
    { icon: 'newchat', label: '开对话', act: 'noteToChat', arg: n.id },
    work ? { icon: 'folder', label: n.project ? esc(PROJECTS[n.project].name) : '挂项目', act: 'sheet', arg: `noteproj:${n.id}` } : null,
    { icon: 'alarm', tone: 'blue', label: n.remind ? esc(n.remind) : '提醒', act: 'sheet', arg: `noteremind:${n.id}` },
    work ? { icon: 'monitor', label: '交接', act: 'toast', arg: '原型：交接卡的「带上」里会多出这条笔记' } : null,
    { icon: 'export', label: '导出', act: 'toast', arg: '原型：打开系统的「保存到」面板' },
  ], work ? 5 : 3);
  return page({
    title: '笔记',
    right: `<button class="ib" data-act="toast" data-arg="原型：你可以编辑原文；小引不会改它" aria-label="编辑">${ic('pen')}</button><button class="ib" data-act="noteArchive" data-arg="${n.id}" aria-label="归档">${ic('archive')}</button><button class="ib" data-act="sheet" data-arg="notedel:${n.id}" aria-label="删除">${ic('trash')}</button>`,
    body: `<div class="note-detail pb">${raw}${derive}<div class="card use">${use}</div></div>`,
  });
};
ACT.noteClear = id => { const n = S.notes.find(x => x.id === id); n.derive = null; render(); toast('已清除整理结果，原文没有变'); };
ACT.noteTidyOne = async id => { toast('正在整理…'); await sleep(900); const n = S.notes.find(x => x.id === id); n.derive = { tags: n.mode === 'work' ? ['登录页', '文案'] : ['出行', '崇明'], sum: '整理结果是另存的一层。', rel: n.mode === 'work' ? '对话「登录页改版」' : '' }; render(); };
ACT.noteToChat = id => notesIntoChat([id]);
ACT.noteArchive = id => { const n = S.notes.find(x => x.id === id), was = n.box; n.box = 'archived'; S.stack.pop(); snack('已归档', () => { n.box = was; }); };
SHEETS.notedel = ({ id }) => sheet('删除这条笔记？', `<div class="hint" style="font-size:14px">删除后不能恢复。</div>`,
  { foot: `<button class="btn ghost grow" data-act="closeSheet">留着</button><button class="btn danger grow" data-act="noteDel" data-arg="${id}">删除</button>` });
ACT.noteDel = id => { dropNote(id); S.sheet = null; S.stack.pop(); render(); toast('已删除'); };
SHEETS.noteproj = ({ id }) => sheet('挂到项目', group(Object.values(PROJECTS).map(p => row({ icon: 'folder', title: esc(p.name), right: esc(computerLabel(S.computers[p.device])), act: 'noteProj', arg: `${id}|${p.id}`, chev: false }))));
ACT.noteProj = arg => { const [id, pid] = arg.split('|'); const n = S.notes.find(x => x.id === id); n.project = pid; n.box = 'filed'; S.sheet = null; render(); toast(`已挂到 ${PROJECTS[pid].name}，移出收件箱`); };
SHEETS.noteremind = ({ id }) => sheet('什么时候提醒', `${group(['今晚 20:00', '明早 09:00', '周六 10:00'].map(w => row({ icon: 'alarm', tone: 'blue', title: w, act: 'noteRemind', arg: `${id}|${w}` })))}
  ${S.set.sys.exact === 'denied' ? box('没有「精确定时」许可，提醒可能晚几分钟。<button class="btn text" data-act="go" data-arg="perms" style="height:20px">去看权限</button>', 'amber', 'warn') : ''}`);
ACT.noteRemind = arg => {
  const [id, when] = arg.split('|'); const n = S.notes.find(x => x.id === id);
  n.remind = when;
  const r = { id: uid('r'), mode: n.mode, text: noteTitle(n).slice(0, 14), when, src: '笔记', on: true };
  S.rems.unshift(r); S.sheet = null;
  snack(`提醒已设：${when}`, () => { S.rems = S.rems.filter(x => x !== r); n.remind = null; }, { icon: 'alarm' });
};
ACT.retryAsr = async id => {
  const n = S.notes.find(x => x.id === id);
  if (!S.net) return toast('没有网络：录音还在，联网后再转');
  n.audio.state = 'run'; render();
  await sleep(1400);
  n.audio.state = 'done'; n.audio.text = '下周三下班顺路去取一下干洗的大衣，小票在玄关抽屉里。'; render();
};

/* ================= 快速记一笔（对应独立的轻量原生界面） ================= */
SHEETS.capture = () => {
  const mode = S.flags.capMode || S.mode, life = mode === 'life';
  const atts = S.flags.capAtts || [];
  return `<div class="sheet full capture" role="dialog" data-mode="${mode}">
    <div class="cap-h"><button class="ib" data-act="capClose" aria-label="关闭">${ic('x')}</button><b>记一笔</b>
      <button class="cap-mode" data-act="capMode">${ic(life ? 'sun' : 'brief', 'xs')}记到${life ? '生活' : '工作'}${ic('swap', 'xs')}</button></div>
    <textarea class="cap-in" id="cap-in" placeholder="想到什么，先记下来" data-bind="flags.capText">${esc(S.flags.capText || '')}</textarea>
    ${atts.length ? `<div class="cap-atts">${atts.map((a, i) => `<span class="mat">${ic(a.icon, 'xs')}<span>${esc(a.label)}</span><button data-act="capAttDel" data-arg="${i}" aria-label="移除">${ic('x', 'xs')}</button></span>`).join('')}</div>` : ''}
    <div class="cap-foot">
      <div class="cap-tools"><button data-act="capVoice" aria-label="语音">${ic('mic')}</button><button data-act="capAdd" data-arg="img" aria-label="图片">${ic('camera')}</button><button data-act="capAdd" data-arg="link" aria-label="链接">${ic('link')}</button><button data-act="capAdd" data-arg="rem" aria-label="提醒">${ic('alarm')}</button></div>
      <button class="btn pri" data-act="capSave">${ic('check', 'sm')}保存</button></div>
    <div class="cap-hint">${ic('shieldok', 'xs')}只存本机 · 不用网络</div></div>`;
};
ACT.capMode = () => { S.flags.capMode = (S.flags.capMode || S.mode) === 'life' ? 'work' : 'life'; render(); };
ACT.capAdd = k => {
  const a = { img: { icon: 'image', label: '照片 1 张', key: 'img' }, link: { icon: 'link', label: 'notes.example/idea', key: 'link' }, rem: { icon: 'alarm', label: '明早 09:00 提醒', key: 'rem' } }[k];
  (S.flags.capAtts = S.flags.capAtts || []).push(a); render();
};
ACT.capAttDel = i => { S.flags.capAtts.splice(+i, 1); render(); };
function capReset() { S.flags.capText = ''; S.flags.capAtts = []; S.flags.capMode = null; S.sheet = null; }
ACT.capClose = () => { const back2 = S.flags.capFrom; capReset(); render(); if (back2 === 'launcher') toast('回到主屏幕'); };
ACT.capSave = () => {
  const text = (S.flags.capText || '').trim(), atts = S.flags.capAtts || [];
  if (!text && !atts.length) return toast('还没有写内容');
  const extra = {};
  if (atts.some(a => a.key === 'img')) extra.img = '照片';
  if (atts.some(a => a.key === 'rem')) extra.remind = '明早 09:00';
  const n = addNote(text || '（图片）', S.flags.capVia || '应用内', extra);
  capReset();
  snack(S.net ? '记下了 · 在收件箱' : '记下了 · 没有网络也已存好', () => dropNote(n.id), { icon: 'pen' });
};
ACT.quickNote = () => {
  const key = curConvId(), text = (S.input[key] || '').trim();
  if (!text) return openSheet('capture');
  S.input[key] = '';
  const n = addNote(text, '应用内');
  snack('记下了 · 在收件箱，没有发给模型', () => { dropNote(n.id); S.input[key] = text; }, { icon: 'pen' });
};

/* ================= 语音 ================= */
let recT;
SHEETS.voice = () => `<div class="sheet voice" role="dialog"><i class="grab"></i>
  <div class="rec"><div class="rec-ring"><span>${ic('mic', 'lg')}</span></div><time id="rec-time">0:0${S.flags.recSec || 0}</time>
    <span class="wavebars big">${Array.from({ length: 28 }, (_, i) => `<i style="height:${6 + ((i * 7) % 22)}px;animation-delay:${(i % 7) * 0.09}s"></i>`).join('')}</span>
    ${S.net ? '' : '<p>没有网络：先存录音，联网后再转文字</p>'}</div>
  <div class="sheet-f"><button class="btn ghost" data-act="recCancel">取消</button><button class="btn soft grow" data-act="recSay">${ic('up', 'sm')}说给小引</button><button class="btn pri grow" data-act="recSave">${ic('pen', 'sm')}记一笔</button></div></div>`;
function recStart() {
  clearInterval(recT);
  S.flags.recSec = 0;
  const g = GEN;
  recT = setInterval(() => {
    if (g !== GEN || !S.sheet || S.sheet.n !== 'voice') return clearInterval(recT);
    S.flags.recSec++;
    const el = $('#app #rec-time');
    if (el) el.textContent = `0:${String(S.flags.recSec).padStart(2, '0')}`;
  }, 1000);
}
ACT.voice = () => {
  if (S.set.sys.mic !== 'granted') return toast('需要麦克风权限。去「权限」里允许后再试');
  openSheet('voice'); recStart();
};
ACT.capVoice = () => { S.flags.capText = ''; ACT.voice(); };
ACT.recCancel = () => { clearInterval(recT); S.sheet = null; render(); toast('已取消，没有保存'); };
ACT.recSave = async () => {
  clearInterval(recT);
  const len = `0:${String(Math.max(S.flags.recSec, 3)).padStart(2, '0')}`;
  const n = addNote('', '语音', { audio: { len, state: S.net ? 'run' : 'wait' } });
  S.sheet = null;
  snack(S.net ? '录音已存好，正在转成文字' : '录音已存好 · 联网后转成文字', () => dropNote(n.id), { icon: 'mic' });
  if (!S.net) return;
  await sleep(1800);
  n.audio.state = 'done'; n.audio.text = '回头把交接卡上「带上哪些材料」那一行改成可以点开看。'; render();
};
ACT.recSay = () => {
  clearInterval(recT);
  const key = curConvId() || homeId();
  S.sheet = null;
  if (!S.net) { render(); return toast('没有网络，语音转不了文字。可以先存成语音笔记'); }
  S.input[key] = '帮我看看今天还有什么没处理的';
  render(); toast('转成了文字，放在输入框里，由你决定发不发');
};
