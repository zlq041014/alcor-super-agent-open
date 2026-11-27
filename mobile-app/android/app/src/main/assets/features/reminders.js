import { A, esc, ic } from '../icons.js';

const pad = (n) => String(n).padStart(2, '0');
export const reminderTime = (at) => new Date(at).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const inputTime = (at) => {
  const date = new Date(at);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const lead = /^(?:请\s*)?(?:帮我\s*)?/;
const relative = /^(\d{1,3})\s*(分钟|小时)后\s*提醒我[：:\s]*([^\s][\s\S]*)$/;
const clock = /^(今天|今晚|明天|明早|明晚|后天)?\s*(早上|上午|中午|下午|晚上)?\s*(\d{1,2})\s*(?:[:：](\d{2})|点\s*(半|\d{1,2}\s*分)?)\s*提醒我[：:\s]*([^\s][\s\S]*)$/;

// Only deterministic requests with a single explicit time and literal reminder text run offline.
export function directReminder(value, now = new Date()) {
  const line = value.trim().replace(lead, '');
  const after = relative.exec(line);
  if (after) {
    if (+after[1] === 0) return null;
    return { text: after[3], at: +now + Number(after[1]) * (after[2] === '小时' ? 3600000 : 60000) };
  }
  const parts = clock.exec(line);
  if (!parts) return null;
  const [, day, part, hrs, mins, extra, text] = parts;
  let hour = Number(hrs);
  const minute = mins ? Number(mins) : extra === '半' ? 30 : extra ? Number.parseInt(extra, 10) : 0;
  const namedPeriod = ({ 今晚: '晚上', 明早: '早上', 明晚: '晚上' })[day];
  if (namedPeriod && part && part !== namedPeriod) return null;
  const period = part || namedPeriod;
  if (hour > 23 || minute > 59) return null;
  if ((period === '早上' || period === '上午') && hour >= 12) return null;
  if (['早上', '上午', '中午', '下午', '晚上'].includes(period) && hour === 0) return null;
  if (period === '中午' && ![1, 11, 12, 13].includes(hour)) return null;
  if (['下午', '晚上', '中午'].includes(period) && hour < 12) hour += 12;
  const at = new Date(now);
  at.setDate(at.getDate() + (day === '后天' ? 2 : day?.startsWith('明') ? 1 : 0));
  at.setHours(hour, minute, 0, 0);
  if (at.getHours() !== hour || +at <= +now) return null;
  return { text, at: +at };
}

export const reminderNotice = (permissions) => !permissions ? '' : !permissions.notifications
  ? '通知未开启，到点不会弹出通知' : !permissions.exact ? '未允许精确定时，通知可能延后' : '';
const permissionButtons = (permissions) => [
  !permissions.notifications && '<button class="btn text" data-act="reminder-permission" data-v="notifications">通知设置</button>',
  !permissions.exact && '<button class="btn text" data-act="reminder-permission" data-v="exact">精确定时</button>',
].filter(Boolean).join('');
const warning = (permissions) => reminderNotice(permissions)
  ? `<div class="reminder-warning">${ic('bell', 'sm')}<div>${reminderNotice(permissions)}${permissionButtons(permissions)}</div></div>` : '';
const source = { chat: '来自对话', note: '来自笔记', manual: '手动创建' };
const stateText = { scheduled: '待提醒', posted: '通知已提交', blocked: '未发出通知', cancelled: '已取消' };

export function reminderScreen(state) {
  const { history, items, more, permissions } = state;
  return `<header class="topbar"><button class="icon-btn" data-act="go-home" aria-label="回到总管">${ic('back')}</button>
    <div class="title"><h1>提醒</h1></div></header>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="${!history}" data-act="reminder-tab" data-v="next">待提醒</button>
      <button role="tab" aria-selected="${history}" data-act="reminder-tab" data-v="done">已过</button></div>
    <div class="list reminder-list">${warning(permissions)}
      ${items.length ? items.map((r) => `<button class="reminder-row" data-act="reminder-open" data-v="${esc(r.id)}">
        <span class="reminder-icon">${ic('bell')}</span><span><b>${esc(r.text)}</b>
        <small>${esc(reminderTime(r.at))} · ${history ? stateText[r.state] : source[r.origin]}</small></span>${ic('right', 'sm')}</button>`).join('')
        : `<div class="empty"><img src="${A('reminder')}" alt=""><b>${history ? '还没有记录' : '没有待提醒的事'}</b></div>`}
      ${more ? '<button class="btn ghost" data-act="reminder-more">查看更多</button>' : ''}</div>
    <button class="fab reminder-fab" data-act="reminder-new" aria-label="新提醒">${ic('plus')}</button>`;
}

export function reminderSheet(sh) {
  const r = sh.value;
  const existing = sh.type === 'reminder-detail';
  const editable = !existing || r.state === 'scheduled';
  const when = editable ? `<form data-form="reminder-save">
    <label class="field">内容<input type="text" name="text" maxlength="200" value="${esc(r.text)}" required></label>
    <label class="field">提醒时间<input type="datetime-local" name="at" value="${inputTime(r.at)}" required></label>
    <div class="row-btns"><button type="submit" class="btn primary grow" ${sh.busy ? 'disabled' : ''}>保存</button>
    ${existing ? '<button type="button" class="btn ghost" data-act="reminder-cancel-ask">取消提醒</button>' : ''}</div></form>`
    : `<div class="card-box reminder-read"><b>${esc(r.text)}</b><span>${esc(reminderTime(r.at))} · ${stateText[r.state]}</span></div>`;
  const origin = r.origin === 'note' ? `<button class="btn text" data-act="note-open" data-v="${esc(r.ref)}">查看原笔记</button>`
    : r.origin === 'chat' ? `<button class="btn text" data-act="reminder-source" data-v="${esc(r.ref)}">查看原对话</button>` : '';
  if (sh.type === 'reminder-cancel') return {
    title: '取消提醒？',
    body: `<p class="lead">${esc(r.text)} · ${esc(reminderTime(r.at))}</p><div class="row-btns">
      <button class="btn ghost grow" data-act="reminder-cancel-back">保留</button>
      <button class="btn danger grow" data-act="reminder-cancel" ${sh.busy ? 'disabled' : ''}>确认取消</button></div>`,
  };
  return { title: existing ? '提醒详情' : '新提醒', body: warning(sh.permissions) + when + origin };
}

export function reminderCard(m) {
  const a = m.reminderAction;
  if (!a) return '';
  const button = (label, act) => `<button class="btn text" data-act="reminder-action" data-v="${esc(JSON.stringify([m.id, act]))}">${label}</button>`;
  const desc = `${esc(a.text)} · ${esc(reminderTime(a.at))}`;
  if (a.state === 'ignored' || a.state === 'undone')
    return `<div class="note-action-receipt neutral">${ic('undo', 'xs')}<span>${a.state === 'undone' ? '提醒已撤销' : '已忽略'}</span></div>`;
  if (a.state === 'saved') return `<div class="note-action-receipt">${ic('bell', 'xs')}<span>
    ${a.operation === 'cancel' ? '提醒已取消' : '提醒已设'}：${desc}${a.notice ? '<br>' + esc(a.notice) : ''}</span>
    ${a.operation === 'cancel' ? '' : button('撤销提醒', 'undo')}</div>`;
  return `<div class="card-box note-action"><div class="note-action-title">${ic('bell', 'sm')}
    <b>${a.state === 'saving' ? '核对提醒' : a.operation === 'cancel' ? '确认取消提醒？' : '确认创建提醒？'}</b></div>
    <div class="note-action-quote">${desc}</div><div class="row-btns">${button(a.state === 'saving' ? '核对' : '确认', 'save')}
      ${a.state === 'confirm' ? button('忽略', 'ignore') : ''}</div></div>`;
}
