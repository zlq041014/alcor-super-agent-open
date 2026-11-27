import { A, esc, ic } from '../icons.js';
import { LIFE } from './modes.js';

/* Notes are local records. Nothing here calls the model or a computer. */

const SOURCE = { app: ['应用内', 'pen'], share: ['分享', 'share'], widget: ['小组件', 'grid'], shortcut: ['快捷方式', 'grid'], assistant: ['对话里记下', 'note'] };
const BOX = [['inbox', '收件箱'], ['filed', '已归入'], ['archived', '已归档']];

export const notesState = (ui) => (ui.notes ??= {})[ui.mode] ??= {
  box: 'inbox', query: '', items: [], counts: { inbox: 0, filed: 0, archived: 0 }, more: false, loading: false, error: '',
};

const clock = (at) => {
  const date = new Date(at), today = new Date();
  const same = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return same ? '今天 ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' ' +
      date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
};
const first = (text, n) => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n) + '…' : line || '（图片）';
};
const url = (text) => { const value = String(text ?? '').trim(); return /^https?:\/\/\S+$/i.test(value) ? value : ''; };
const host = (value) => { try { return new URL(value).host; } catch { return value; } };
const projectName = (data, key) => data.projects[key]?.name ?? '';
const noteTitle = (note) => note.text ? first(note.text, 32) : note.image ? '一张图片' : '空笔记';

export function noteCard(data, note, ui) {
  const link = url(note.text), source = SOURCE[note.source] ?? SOURCE.app;
  const tags = [
    note.project ? `<span class="chip sm">${ic('folder', 'xs')}${esc(projectName(data, note.project) || '已挂项目')}</span>` : '',
    note.box === 'archived' ? '<span class="chip sm">已归档</span>' : '',
  ].join('');
  return `<button class="note-card" data-act="note-open" data-v="${esc(note.id)}">
    ${link ? `<div class="n-link">${ic('link', 'sm')}<span><b>${esc(host(link))}</b><small>${esc(link)}</small></span></div>`
      : `<p class="n-text">${esc(first(note.text, 150))}</p>`}
    ${note.image ? `<div class="n-img" aria-label="含一张图片">${ic('image')}<span>图片</span></div>` : ''}
    <div class="n-meta"><span>${ic(source[1], 'xs')}${esc(source[0])} · ${esc(clock(note.created))}</span>${tags}</div>
  </button>`;
}

export function notesScreen(data, ui) {
  const state = notesState(ui);
  const notes = state.items;
  const counts = state.counts;
  const empty = state.loading ? '<div class="empty">正在找…</div>'
    : state.error ? `<div class="empty"><b>没能读取笔记</b><br>${esc(state.error)}</div>`
    : state.query ? `<div class="empty">${artNote('find-sessions')}<b>没有找到</b><span>只在这台手机上按原文查找。</span></div>`
    : state.box === 'inbox' ? `<div class="empty">${artNote('all-clear')}<b>收件箱是空的</b><span>想到什么，先记一笔。</span></div>`
    : `<div class="empty">${artNote('note')}<b>这里还没有笔记</b></div>`;
  return `<header class="topbar"><button class="icon-btn" data-act="go-home" aria-label="回到总管">${ic('back')}</button>
    <div class="title"><h1>笔记</h1><div class="sub">只存本机 · 不用网络</div></div>
    <button class="btn text" data-act="note-capture">记一笔</button></header>
    <label class="search-field">${ic('search', 'sm')}<input id="note-q" placeholder="搜笔记原文" value="${esc(state.query)}" autocomplete="off"></label>
    <div class="tabs" role="tablist">${BOX.map(([key, label]) =>
      `<button role="tab" aria-selected="${state.box === key}" data-act="note-tab" data-v="${key}">${label}${counts[key] ? ' ' + counts[key] : ''}</button>`).join('')}</div>
    <div class="list note-list">${notes.length ? notes.map((note) => noteCard(data, note, ui)).join('') : empty}
      ${state.more ? `<button class="btn ghost grow note-more" data-act="note-more">再找一些</button>` : ''}</div>
    <button class="fab" data-act="note-capture" aria-label="记一笔">${ic('pen')}<span>记一笔</span></button>`;
}

function artNote(name) { return name ? `<img src="${A(name)}" alt="" width="96" height="96">` : ''; }

export function noteScreen(data, ui) {
  const note = ui.note;
  if (!note) return `<header class="topbar"><button class="icon-btn" data-act="go-notes" aria-label="回到笔记">${ic('back')}</button><div class="title"><h1>笔记</h1></div></header>
    <div class="empty"><b>这条笔记已经不在了</b></div>`;
  const link = url(note.text), source = SOURCE[note.source] ?? SOURCE.app;
  const project = projectName(data, note.project);
  const label = ui.noteBack === 'chat' ? '回到对话' : ui.noteBack === 'reminders' ? '回到提醒' : '回到笔记';
  return `<header class="topbar"><button class="icon-btn" data-act="note-back" aria-label="${label}">${ic('back')}</button>
    <div class="title"><h1>笔记</h1><div class="sub">${esc(source[0])} · ${esc(clock(note.created))}</div></div>
    <button class="icon-btn" data-act="note-edit" data-v="${esc(note.id)}" aria-label="编辑原文">${ic('pen')}</button>
    <button class="icon-btn" data-act="note-archive" data-v="${esc(note.id)}" aria-label="${note.box === 'archived' ? '取消归档' : '归档'}">${ic('archive')}</button>
    <button class="icon-btn" data-act="note-delete-ask" data-v="${esc(note.id)}" aria-label="删除">${ic('trash')}</button></header>
    <div class="note-detail">
      <div class="card-box note-raw">
        ${link ? `<button class="n-link big" data-act="browse" data-v="${esc(link)}">${ic('link')}<span><b>${esc(host(link))}</b><small>${esc(link)}</small></span></button>`
          : `<p class="n-big">${esc(note.text)}</p>`}
        ${note.image ? `<button class="n-img big" data-act="note-image" data-v="${esc(note.id)}">${ic('image', 'lg')}<span>图片 1 张 · 打开</span></button>` : ''}
        <div class="n-meta"><span>${ic(source[1], 'xs')}${esc(source[0])} · 记录于 ${esc(clock(note.created))}</span>
          ${note.modified && note.modified !== note.created ? `<span>改于 ${esc(clock(note.modified))}</span>` : ''}
          ${project ? `<span class="chip sm">${ic('folder', 'xs')}${esc(project)}</span>` : ''}
          ${note.box === 'archived' ? '<span class="chip sm">已归档</span>' : ''}</div>
      </div>
      <div class="tiles c3">
        <button class="tile" data-act="note-chat" data-v="${esc(note.id)}">${ic('note')}<span>开对话</span></button>
        ${ui.mode === LIFE ? '' : `<button class="tile" data-act="note-project" data-v="${esc(note.id)}">${ic('folder')}<span>${project ? '换项目' : '挂项目'}</span></button>`}
        <button class="tile" data-act="reminder-from-note" data-v="${esc(note.id)}">${ic('bell')}<span>设提醒</span></button>
        <button class="tile" data-act="note-export" data-v="${esc(note.id)}">${ic('ext')}<span>导出</span></button>
      </div>
      <p class="foot-note">原文不会因为整理或对话而改变。删掉这条笔记前，转进对话的副本仍在。</p>
    </div>`;
}

export function noteSheet(data, ui, sh) {
  if (!sh) return null;
  if (sh.type === 'note-delete') {
    const id = sh.value;
    return { title: '删除这条笔记？', body: '<p class="lead">删除后不能恢复。转进对话的副本不受影响。</p>' +
      `<div class="row-btns"><button class="btn ghost grow" data-act="close">留着</button><button class="btn danger grow" data-act="note-delete" data-v="${esc(id)}">删除</button></div>` };
  }
  if (sh.type === 'note-project') {
    const note = ui.note;
    if (!note) return null;
    const projects = Object.values(data.projects).filter((p) => p.shared);
    return { title: '挂到项目', body: (projects.length ? projects.map((p) =>
      `<button class="choice" data-act="note-attach" data-v="${esc(JSON.stringify([note.id, p.key]))}">${ic('folder')}<span class="t"><b>${esc(p.name)}</b><span>${esc(data.peers[p.peer]?.name ?? '电脑')}</span></span>${ic('right', 'sm')}</button>`).join('')
      : '<p class="lead">还没有已同步的项目。先配对电脑并在电脑上共享项目。</p>') +
      (note.project ? `<button class="btn text" data-act="note-attach" data-v="${esc(JSON.stringify([note.id, '']))}">不挂项目，放回收件箱</button>` : '') };
  }
  if (sh.type === 'note-edit') {
    const note = ui.note;
    if (!note) return null;
    return { title: '编辑原文', body: `<form data-form="note-edit"><label class="field">原文<textarea name="text" maxlength="16000" required>${esc(note.text)}</textarea></label>
      <div class="row-btns"><button type="submit" class="btn primary grow">保存</button></div></form>` };
  }
  return null;
}
