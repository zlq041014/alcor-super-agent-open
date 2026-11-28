import { sharedDeliveries } from './model.js';
import { A, esc, ic } from './icons.js';
import { diagramMarkup, reading } from './reading.js';
import { slidesSheet } from './features/slides.js';
import { chosen, decisions, listDialogs, materialMode, transcript } from './model.js';
import { noteScreen, noteSheet, notesScreen, notesState } from './features/notes.js';
import { estimate, formatCost, formatTokens, PRICE_DATE, todayCost } from './features/usage.js';
import { activeSummary, coveredIds, coveredMessages } from './features/context.js';
import { LENGTHS, TONES, personaPreview } from './features/persona.js';
import { reminderCard, reminderScreen, reminderSheet } from './features/reminders.js';
import { LIFE, WORK, homeId, inMode, toolPrefs } from './features/modes.js';
import { memoryReceipt, memoryScreen, memorySheet, memoryUsed } from './features/memory.js';
import { pendingWork, unreadWork } from './features/work-notices.js';
import { agentDetails, agentScreen } from './features/agent-tree.js';
import { petCanvas } from './features/pet.js';

export const kind = {
  home: ['总管对话', 'avatar', 'manager'], discussion: ['项目讨论', 'decision', 'disc'],
  codex: ['Codex', 'exec-codex', 'codex'], dsh: ['DSH', 'exec-dsh', 'dsh'],
};
export const stage = {
  local: ['已记下，等电脑上线', 'st-local', 1], sending: ['正在确认送达', 'st-verify', 1],
  uploading: ['正在传送材料，尚未派工', 'st-local', 1], 'upload-paused': ['材料传送暂停，尚未派工', 'st-verify', 1],
  queued: ['电脑已收到，等待执行', 'st-queued', 2], verify: ['送达待核对', 'st-verify', 2],
  running: ['执行中', 'st-running', 3], waiting: ['等待处理', 'st-verify', 3],
  review: ['待验收', 'st-review', 4], done: ['已完成', 'st-done', 5],
  failed: ['执行失败', 'st-failed', 1], cancelled: ['已撤销，未派发', 'st-local', 1],
};
const when = (at) => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';
const sourceHost = (url) => { try { return new URL(url).host; } catch { return url; } };
export const button = (label, act, v = '', appearance = 'ghost') =>
  `<button type="button" class="btn ${appearance}" data-act="${act}" data-v="${esc(v)}">${label}</button>`;
const acceptResult = (w, label) => button(label, 'accept', JSON.stringify([w.id, w.receipt.evidenceHash]), 'primary');
const icon = (img, label, act, value = '', cls = '', badge = '') =>
  `<button type="button" class="icon-btn ${cls}" aria-label="${label}" data-act="${act}" data-v="${esc(value)}">${ic(img)}${badge}</button>`;
const tag = (id) => `<span class="tag ${kind[id][2]}">${kind[id][0]}</span>`;
const status = (w) => `<span class="state ${stage[w.stage][1]}"><span class="dot"></span>${stage[w.stage][0]}</span>`;
const art = (name) => `<img src="${A(name)}" alt="">`;
const head = (img, title, subtitle) => `<div class="card-head">${art(img)}<div class="t"><b>${esc(title)}</b><span>${esc(subtitle)}</span></div></div>`;
const card = (body) => `<div class="msg card"><div class="card-box">${body}</div></div>`;
const row = (body) => `<div class="row-btns">${body}</div>`;
const foot = (body) => `<div class="foot-note">${body}</div>`;
const materialLabel = (file, mode) => ({
  original: /\.(png|jpe?g|webp|gif)$/i.test(file.name) ? '图片原件' : '文件原件 · 执行回合每份最多读 30,000 字',
  excerpt: /\.zip$/i.test(file.name) ? 'ZIP 文字摘录 · 不含图片' : '文字摘录 · 最多 2,500 字',
  unsupported: '此目标不支持', unselected: '选择目标后确认',
})[mode];
const materialReceipt = (r) => !r?.materialCount ? '' : foot('电脑已收到 ' + r.materialCount + ' 份材料。' +
  (r.materialInputs?.map((x) => '本回合已传入' + ({ image: '图片', text: '正文', binary: '文件信息', excerpt: '正文摘录' })[x.kind] +
    ' ' + x.count + ' 份' + (x.truncated ? '（' + x.truncated + ' 份截断）' : '') + '。').join('') ||
    (r.stage === 'failed' || r.stage === 'done' || r.stage === 'review' ? '未取得本回合的材料回执。' : '等待执行回合提供材料回执。')));
const issue = (body) => body ? `<div class="error" role="alert">${esc(body)}</div>` : '';
const choice = (img, title, sub, act, v) =>
  `<button class="choice" data-act="${act}" data-v="${esc(v)}">${img ? art(img) : ''}<div class="t"><b>${esc(title)}</b><span>${esc(sub)}</span></div>${ic('right', 'sm')}</button>`;
const wrap = (title, body, problem, cls = '') => `<div class="scrim" data-act="close"></div><section class="sheet ${cls}" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="grab"></div><div class="sheet-title"><h2>${esc(title)}</h2>${icon('x', '关闭', 'close')}</div>${issue(problem)}${body}</section>`;
const lead = (body) => `<p class="lead">${body}</p>`;
const field = (label, name, value, options = {}) => {
  const { placeholder = '', type = 'text', max = 120, extra = '' } = options;
  return `<label class="field">${label}${type === 'textarea'
    ? `<textarea name="${name}" maxlength="${max}" placeholder="${esc(placeholder)}" ${extra}>${esc(value)}</textarea>`
    : `<input name="${name}" type="${type}" maxlength="${max}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" ${extra}>`}</label>`;
};
const form = (act, body, label, busy) => `<form data-form="${act}">${body}${row(`<button type="submit" class="btn primary grow" ${busy ? 'disabled' : ''}>${label}</button>`)}</form>`;
const select = (label, name, choices) => `<label class="field">${label}<select name="${name}">${choices}</select></label>`;
const option = (value, label, selected) => `<option value="${esc(value)}" ${selected ? 'selected' : ''}>${esc(label)}</option>`;
const section = (title, body) => `<div class="section">${title ? `<h3>${title}</h3>` : ''}${body}</div>`;
const compact = (value, n = 140) => value.length > n ? value.slice(0, n) + '…' : value;

export function view(data, ui) {
  if (['agent-projects', 'agent-project'].includes(ui.screen)) {
    const screen = agentScreen(data, ui);
    if (ui.sheet?.type !== 'agent-node') return screen;
    const node = data.agentTrees?.[ui.agentProject]?.nodes.find((n) => n.id === ui.sheet.value);
    const panel = agentDetails(data, ui.agentProject, node);
    return panel && ui.settings.peers.some((p) => p.id === data.projects[ui.agentProject]?.peer)
      ? screen + wrap(panel.title, panel.body, ui.sheet.error) : screen;
  }
  const memoryOverlay = ['memory-detail', 'memory-delete', 'memory-used'].includes(ui.sheet?.type)
    ? memorySheet(data, ui.sheet) : null;
  const renderMemoryOverlay = () => memoryOverlay ? wrap(memoryOverlay.title, memoryOverlay.body, ui.sheet.error) : '';
  if (ui.screen === 'memory') return memoryScreen(data, ui) + renderMemoryOverlay();
  const reminderOverlay = ['reminder-new', 'reminder-detail', 'reminder-cancel'].includes(ui.sheet?.type)
    ? reminderSheet(ui.sheet) : null;
  const renderReminderOverlay = () => reminderOverlay ? wrap(reminderOverlay.title, reminderOverlay.body, ui.sheet.error) : '';
  if (ui.screen === 'reminders') return reminderScreen(ui.reminders) + renderReminderOverlay();
  if (ui.screen === 'notes' || ui.screen === 'note') {
    const screen = ui.screen === 'notes' ? notesScreen(data, ui) : noteScreen(data, ui);
    if (reminderOverlay) return screen + renderReminderOverlay();
    const sh = ui.sheet;
    if (!sh) return screen;
    const overlay = noteSheet(data, ui, sh);
    if (overlay) return screen + wrap(overlay.title, overlay.body, sh.error);
    if (sh.type === 'export') return screen + wrap('导出成果', lead(esc(sh.value.title)) +
      foot('保存和分享使用同一份 Markdown，正文后附出处。') +
      row(button('保存 .md', 'export-save', '', 'primary grow') + button('系统分享', 'export-share', '', 'ghost grow')) +
      row(button('复制导出内容', 'export-copy', '', 'text')), sh.error);
    return screen;
  }
  const d = data.dialogs[ui.current];
  const life = ui.mode === LIFE;
  const peers = life ? [] : ui.settings.peers;
  const dialogs = listDialogs(data, ui.mode);
  const summaryRecord = activeSummary(d);
  const covered = coveredIds(d, summaryRecord);
  const attachable = life ? [] : Object.values(data.projects).filter((p) => p.shared);
  const canAttach = d.kind === 'discussion' && !d.project && !d.peer && attachable.length > 0 &&
    d.messages.some((m) => m.role === 'user' || m.role === 'assistant');
  const spentToday = todayCost(dialogs);
  const usageLine = (m) => {
    const u = m.usage, parts = [];
    if (u) {
      if (u.prompt != null) parts.push('输入 ' + formatTokens(u.prompt));
      if (u.hit != null || u.miss != null) parts.push('命中 ' + formatTokens(u.hit ?? 0) + ' / 未命中 ' + formatTokens(u.miss ?? 0));
      if (u.completion != null) parts.push('输出 ' + formatTokens(u.completion));
      if (u.reasoning) parts.push('思考 ' + formatTokens(u.reasoning));
    } else if (m.usageMissing) parts.push('接口未返回用量');
    const cost = u ? estimate(u) : null;
    if (cost != null) parts.push('模型 ≈' + formatCost(cost));
    if (m.toolCost) parts.push('工具 ≈' + formatCost(m.toolCost));
    if ((cost != null || m.toolCost) && spentToday > 0) parts.push('今日 ' + formatCost(spentToday));
    if (!parts.length) return '';
    const label = cost != null ? '≈' + formatCost(cost + (m.toolCost ?? 0)) + '（估）'
      : m.toolCost ? '工具 ≈' + formatCost(m.toolCost) : u ? '用量' : '无用量';
    return `<details class="usage" data-expand="usage-${esc(m.id)}"><summary aria-label="用量与花费">${esc(label)}${ic('right', 'xs')}</summary><div>${esc(parts.join(' · '))}</div></details>`;
  };
  const toolLine = (m) => {
    if (!m.tools?.length) return '';
    const counts = {};
    for (const run of m.tools) counts[run.label ?? run.name] = (counts[run.label ?? run.name] ?? 0) + 1;
    const took = m.tools.reduce((sum, run) => sum + (run.ms ?? 0), 0);
    const bad = m.tools.some((run) => !run.ok);
    return `<details class="tool-run${bad ? ' bad' : ''}" data-expand="tool-${esc(m.id)}"><summary><span>${bad ? '工具没有完成' : esc(Object.entries(counts).map(([name, count]) => `${name} ×${count}`).join(' · '))}</span><em>${took < 1000 ? took + ' 毫秒' : (took / 1000).toFixed(1) + ' 秒'}</em>${ic('right', 'sm chev')}</summary>` +
      m.tools.map((run) => `<div class="tool${run.ok ? '' : ' bad'}"><b>${esc(run.label ?? run.name)}</b><time>${run.ms ?? 0} ms</time><small>${esc([run.arg, run.ok ? run.summary : run.error].filter(Boolean).join(' · '))}</small></div>`).join('') + '</details>';
  };
  const sourceLine = (m) => {
    if (!m.tools?.length) return '';
    const seen = new Set();
    const sources = [];
    for (const run of m.tools) for (const source of run.sources ?? []) {
      if (!/^https?:\/\//i.test(source.url) || seen.has(source.url)) continue;
      seen.add(source.url);
      sources.push(source);
    }
    if (!sources.length) return '';
    return `<div class="srcs">${sources.map((source, i) => `<a class="src-item" href="${esc(source.url)}" data-act="browse" data-v="${esc(source.url)}"><em>${i + 1}</em><div>${esc(source.title || source.url)}<small>${esc(sourceHost(source.url))}${source.at ? ' · ' + esc(when(source.at)) : ''}</small></div></a>`).join('')}</div>`;
  };
  const noteAction = (m) => {
    const a = m.noteAction;
    if (!a) return '';
    const act = (label, decision, appearance) => button(label, 'note-action', JSON.stringify([m.id, decision]), appearance);
    if (a.state === 'confirm' || a.state === 'saving') return `<div class="card-box note-action">
      <div class="note-action-title">${ic('shield', 'sm')}<b>${a.state === 'confirm' ? '确认记入笔记？' : '核对是否已保存'}</b></div>
      ${a.state === 'confirm' && a.tainted ? foot('读过外部资料') : ''}
      <div class="note-action-quote">${esc(a.text)}</div>
      ${row(act(a.state === 'saving' ? '核对并保存' : '记入笔记', 'save', 'primary grow') +
        (a.state === 'confirm' ? act('忽略', 'ignore', 'ghost grow') : ''))}</div>`;
    if (a.state === 'saved') return `<div class="note-action-receipt">${ic('pen', 'xs')}<span>记进收件箱：${esc(a.text)}</span>${act('撤销', 'undo', 'text')}</div>`;
    return `<div class="note-action-receipt neutral">${ic(a.state === 'undone' ? 'undo' : 'x', 'xs')}<span>${a.state === 'undone' ? '已撤销' : '已忽略'}</span></div>`;
  };
  const topStatus = (small = false) => {
    if (life) return '';
    const active = peers.filter((x) => data.peers[x.id]?.online).length;
    return `<button class="pill nowrap" data-act="sheet" data-v="devices" aria-label="电脑">${ic('monitor', 'xs')}${small ? '' : peers.length ? '电脑 ' : '配对'}${peers.length ? active + '/' + peers.length : ''}</button>`;
  };
  const banner = ui.online ? '' : `<div class="banner offline"><img src="${A('offline-phone')}" alt="" width="34" height="34"><div>手机没有网络。可以看记录、存草稿；新的回答和搜索要等联网。</div></div>`;
  const legacyBanner = ui.legacyIssue ? `<div class="banner offline" role="status"><div>${esc(ui.legacyIssue)}</div></div>` : '';
  const project = (d) => data.projects[d.project];
  const origin = (d) => d.kind === 'discussion' && !d.project ? '只在手机'
    : [project(d)?.name ?? '未归类', data.peers[d.peer]?.name ?? '手机'].join(' · ');
  const kindLabel = (d) => d.kind === 'discussion' && !d.project ? '对话' : kind[d.kind][0];
  const tagFor = (d) => d.kind === 'discussion' && !d.project ? '<span class="tag disc">对话</span>' : tag(d.kind);
  const back = icon('back', '回到总管', 'go', homeId(ui.mode));
  const isHome = d.kind === 'home';
  const native = d.kind === 'codex' || d.kind === 'dsh';
  const targetLabel = (w) => {
    if (!w.target) return '选择电脑与项目';
    if ('threadId' in w.target) {
      const session = Object.values(data.dialogs).find((x) => x.project === w.project && x.session?.threadId === w.target.threadId && x.kind === w.target.backend);
      return `${kind[w.target.backend][0]} 原会话${session ? '「' + session.title + '」' : ''}`;
    }
    return `新建 ${kind[w.target.backend][0]} 托管工作`;
  };
  const place = (w) => {
    const p = data.projects[w.project];
    if (!p) return esc(targetLabel(w));
    return `<span class="pill"><span class="dot ${data.peers[p.peer]?.online ? 'on' : 'off'}"></span>${esc(data.peers[p.peer]?.name ?? '电脑')}</span> <span class="pill">${esc(p.name)}</span><br>${esc(targetLabel(w))}`;
  };
  const handoffFiles = (w) => w.materials ?? (w.refs ?? []).map((ref) => {
    const file = data.dialogs[w.dialog].wxFiles?.find((f) => f.ref === ref);
    return file ? { name: file.name, mode: materialMode(file, w.target) } : { name: '已移除的材料', mode: 'unsupported' };
  });
  const handoffDecision = (w) => {
    const d = data.dialogs[w.dialog];
    const pinned = w.command?.decision;
    if (pinned) return decisions(d).find((item) => item.id === pinned.id)?.versions.find((v) => v.version === pinned.version)?.text;
    if (w.stage !== 'draft' || !w.project || w.project !== d.project || d.kind !== 'discussion') return undefined;
    const selected = chosen(d);
    return selected?.versions.find((v) => v.version === selected.heads[0])?.text;
  };
  const taskInfo = (w) => {
    const decision = handoffDecision(w);
    return `<dl class="kv"><dt>做什么</dt><dd>${esc(w.goal || '待填写')}</dd><dt>发往</dt><dd>${place(w)}</dd>
    <dt>权限</dt><dd>${!w.target ? '待选择' : 'threadId' in w.target ? '沿用原会话权限' : w.target.mode === 'write' ? '项目内写入' : '项目内只读'}</dd>
    <dt>验收</dt><dd>${esc(w.acceptance)}</dd>${decision ? '<dt>附带决定</dt><dd>' + esc(decision) + '</dd>' : ''}
    ${handoffFiles(w).map((f, i) => `<dt>${i ? '' : '材料'}</dt><dd>${esc(f.name)} · ${materialLabel(f, f.mode)}</dd>`).join('')}</dl>`;
  };
  const artifacts = (w) => (w.receipt?.artifacts ?? []).map((a) => choice('receipt', a.name, '交付产物 · 文本预览',
    'artifact', JSON.stringify([w.id, a.id]))).join('');
  const task = (w) => {
    if (w.stage === 'draft') return card(head('handoff', '交给电脑', '确认后才会发送 · ' + w.id.slice(0, 8)) + taskInfo(w) +
      row(button('交给电脑', 'authorize', w.id, 'primary grow') + button('编辑交接', 'edit-work', w.id) + button('先不发', 'dismiss', w.id, 'text')) +
      foot('点「交给电脑」即对这个目标授权一次。「接着聊」、看进度、认可文案都不算开工。'));
    const last = w.log.at(-1);
    const r = w.receipt;
    const off = w.peer && !data.peers[w.peer]?.online;
    const dots = `<div class="steps" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= stage[w.stage][2] ? 'on' : ''}"></i>`).join('')}</div>`;
    const actions = ['local', 'upload-paused', 'uploading'].includes(w.stage)
      ? (w.stage === 'upload-paused' ? button('重传材料', 'retry-material', w.id, 'primary') : '') +
        (w.stage !== 'uploading' ? button('修改', 'edit-work', w.id) : '') + button('撤销', 'cancel', w.id, 'danger')
      : w.stage === 'review' && r?.evidenceHash ? acceptResult(w, '核对无误，验收') : r?.question ? button('回答问题', 'question', w.id, 'primary') : '';
    const linked = 'threadId' in (w.target ?? {}) && Object.values(data.dialogs).find((x) => x.project === w.project &&
      x.kind === w.target.backend && x.session?.threadId === w.target.threadId && x.session?.source === w.target.source);
    return card(head('handoff', w.goal, targetLabel(w)) + '<div>' + status(w) + '</div>' + dots +
      `<div class="evidence">${art(w.stage === 'local' ? 'computer-asleep' : 'receipt')}<div>${esc(last?.detail)}${last ? ' · ' + esc(when(last.at)) : ''}${off && w.stage !== 'local' ? '<br>电脑未连接，显示最后一条回执。' : ''}${r?.turnId ? '<br>回合 ' + esc(r.turnId) : ''}</div></div>` +
      (w.stage === 'verify' ? foot('只核对这次请求，星引不会创建新请求重发。') : '') +
      materialReceipt(r) +
      (r?.text ? `<div class="receipt-result reading">${reading(r.text, true)}</div>` : '') + (r?.diff ? `<div class="diff">${esc(r.diff)}</div>` : '') +
      artifacts(w) +
      row(actions + (linked ? button('原会话', 'open', linked.id) : '') + button('全部回执 ›', 'work', w.id, 'text')));
  };
  const message = (m) => {
    if (m.kind === 'memory-receipt') return memoryReceipt(m);
    if (m.kind === 'handoff') return !life && data.work[m.work] ? task(data.work[m.work]) : '';
    if (m.kind === 'link') return inMode(data.dialogs[m.to], ui.mode) ? `<button class="sysline" data-act="open" data-v="${esc(m.to)}">${esc(m.text)} ›</button>` : '';
    if (m.kind === 'note-link') return `<button class="sysline" data-act="note-open" data-v="${esc(m.note)}">${esc(m.text)} ›</button>`;
    if (m.kind === 'choices') return card(m.items.filter((id) => data.dialogs[id]).map((id) => data.dialogs[id])
      .map((x) => choice(kind[x.kind][1], x.title, kindLabel(x) + ' · ' + origin(x) + ' · ' + when(x.history?.at ?? x.listedAt), 'pick-session', JSON.stringify([x.id, m.id]))).join('') +
      button('都不是，开一场新讨论', 'sheet', 'new', 'text') + foot('打开只读记录，不会向电脑发送任务。'));
    if (m.kind === 'search') return card(head('search-source', `联网搜索 · ${m.items.length} 个来源`, '检索于 ' + when(m.at) + ' · ' + (m.provider ?? 'Brave Search')) +
      `<div class="src-list">${m.items.map((s, i) => `<a class="src-item" href="${esc(s.url)}" data-act="browse" data-v="${esc(s.url)}"><em>[${i + 1}]</em><div>${esc(s.title)}<small>${esc(s.domain)}</small></div></a>`).join('')}</div>`);
    if (m.kind === 'drafts') return card(head('phone-assistant', '文案备选', '在手机完成 · 选定后只会记下决定') +
      m.items.map((item, index) => {
        const value = JSON.stringify([m.id, index]);
        return `<div class="draft${m.picked === index ? ' picked' : ''}"><div class="t"><q>${esc(item.text)}</q><small>${esc(item.reason)}</small></div>
          ${icon('copy', '复制文案', 'copy-draft', value)}${m.picked === undefined ? button('用这个', 'pick-draft', value)
          : m.picked === index ? '<span class="state st-review">已选</span>' : ''}</div>`;
      }).join(''));
    if (m.role === 'system') return `<div class="sysline">${esc(m.text)}</div>`;
    if (!m.text && !m.tools?.length && m.reminderAction) return reminderCard(m);
    const user = m.role === 'user';
    const meta = m.origin ? m.origin : m.draft ? '草稿 · 未发送' : user ? '已存手机 ' + when(m.at) : when(m.at);
    return `<div class="msg ${user ? 'user' : 'manager'}${m.origin ? ' synced' : ''}" data-message="${esc(m.id)}">
      ${!user ? toolLine(m) : ''}
      <div class="bubble${user ? '' : ' reading md'}${m.pending && m.text ? ' cursor' : ''}">${m.pending && !m.text ? '<span class="typing" aria-label="等待答复"><i></i><i></i><i></i></span>' : user ? esc(m.text) : reading(m.text, !m.pending)}</div>
      ${!user ? sourceLine(m) : ''}
      ${m.fileNames?.length ? foot(esc('本轮材料：' + m.fileNames.join('、'))) : ''}
      <div class="meta">${esc(meta)}${m.draft && ui.online ? button('发送', 'send-draft', m.id, 'text') : ''}${!user && m.text && !m.pending
        ? icon('copy', '复制', 'copy-message', m.id) + icon('ext', '导出回复', 'export-message', m.id) : ''}</div>
      ${!user && !m.pending ? memoryUsed(m) + usageLine(m) : ''}
      ${!user && !m.pending && m.contextNote ? '<div class="usage warn">' + esc(m.contextNote) + '</div>' : ''}
      ${issue(m.error)}${m.error && m.input && !m.noteAction && !m.reminderAction && !m.memoryAction ? button('重试', 'retry', m.id, 'text') : ''}
      ${noteAction(m)}${reminderCard(m)}${memoryReceipt(m)}</div>`;
  };
  const visible = transcript(d).filter((m) => !covered.has(m.id)).map((m) => m.turn && !m.origin ? { ...m, origin: kind[d.kind][0] + ' 原会话' } : m);
  const summaryRow = summaryRecord && covered.size ? `<button class="summary-card" data-act="summary" data-v="${esc(d.id)}"><span class="n-label">第 1–${summaryRecord.count} 条 · 第 ${summaryRecord.version} 版</span><b>前情摘要</b><small>较早的内容已整理，原文都在</small>${ic('right', 'sm')}</button>` : '';
  const olderPending = d.messages.filter((m) => covered.has(m.id) && ['confirm', 'saving'].includes(m.noteAction?.state));
  const olderReminders = d.messages.filter((m) => covered.has(m.id) && ['confirm', 'saving'].includes(m.reminderAction?.state));
  const conversation = summaryRow + olderPending.map(noteAction).join('') + olderReminders.map(reminderCard).join('') + visible.map(message).join('');
  const recent = dialogs.filter((x) => x.kind !== 'home' && x.used).sort((a, b) => b.used - a.used)[0];
  const conflicts = dialogs.filter((x) => decisions(x).some((y) => y.heads.length > 1));
  const work = Object.values(data.work);
  const hasPendingWork = work.some((w) => pendingWork(w));
  const unreadWorkCount = work.filter((w) => unreadWork(w)).length;
  const agenda = (image, kicker, title, subtitle, act, value, warning = false) =>
    `<button class="agenda-item" data-act="${act}" data-v="${esc(value)}" aria-label="${esc([kicker, title, subtitle].filter(Boolean).join(' · '))}">
    ${art(image)}<div class="t"><b>${esc(title)}</b><span><em class="kicker${warning ? ' warn' : ''}">${esc(kicker)}</em>${subtitle ? ' · ' + esc(subtitle) : ''}</span></div>${ic('right', 'sm')}</button>`;
  const homeItems = [
    ...conflicts.slice(0, 1).map((x) => agenda('decision', '需要你选一下', '一项决定在两处被改过', x.title, 'conflict', x.id, true)),
    ...(life ? [] : work).filter((w) => w.stage !== 'draft' && w.stage !== 'cancelled').sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4)
      .map((w) => agenda(w.receipt?.question ? kind[w.target.backend][1] : 'handoff', w.receipt?.question ? '执行端在等你回答' : stage[w.stage][0],
        w.goal, targetLabel(w), w.receipt?.question ? 'question' : 'work', w.id, ['verify', 'waiting', 'review', 'failed'].includes(w.stage))),
    ...(recent ? [agenda(kind[recent.kind][1], '继续上次讨论', recent.title, origin(recent), 'open', recent.id)] : []),
  ];
  const modelState = !ui.settings.ready ? '<span class="dot warn"></span>DeepSeek 未接入'
    : ui.online ? '<span class="dot on"></span>DeepSeek · 手机直连' : '<span class="dot off"></span>手机离线';
  const hour = new Date().getHours();
  const greeting = hour < 10 ? '早上好' : hour < 12 ? '上午好' : hour < 14 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
  const petControl = `<button type="button" class="home-pet" data-act="pet-poke" aria-label="戳一下小引">${petCanvas()}</button>`;
  const petStatus = `<button type="button" class="pet-cap" data-act="pet-details"><span>${esc(data.persona.name)}</span> · <span data-pet-label>待命</span>${ic('right','xs')}</button>`;
  const heroStatus = `<div class="hero-status">${ui.settings.ready ? '<span>' + modelState + '</span>' :
    button(ic('key','xs') + '接入 DeepSeek', 'sheet', 'setup', 'hero-chip')}${ui.settings.ready ? topStatus(true) : ''}</div>`;
  const hero = (compact) => compact
    ? `<div class="hero compact">${petControl}<div class="hero-info"><b class="greet">${greeting}</b>${petStatus}</div>
      ${ui.settings.ready ? '' : button('接入 DeepSeek', 'sheet', 'setup', 'hero-chip')}</div>`
    : `<div class="hero">${petControl}${petStatus}<h1 class="greet">${greeting}</h1>${heroStatus}</div>`;
  const starter = (img, label, action, value = '') => button(art(img) + '<b>' + label + '</b>', action, value, 'starter');
  const setup = ui.settings.ready ? '' : `<div class="card-box starters"><b>我是${esc(data.persona.name)}，直接说就行</b><div>
    ${starter('note', '随手记', 'note-capture')}${starter('phone-assistant', '接着聊', 'sheet', 'setup')}${life ? starter('reminder', '设提醒', 'go-reminders') : starter('handoff', '交给电脑', 'sheet', 'devices')}</div></div>`;
  const conflict = decisions(d).find((x) => x.heads.length > 1);
  const leadCtx = !isHome ? button(ic('clip', 'xs') + ' 本轮材料 ' + ui.contextCount(d), 'sheet', 'context', 'chip ctx') : '';
  const placeholder = life ? '想到什么，直接说' : isHome ? '说说要做的事' : native ? '围绕这个会话讨论（不写入原会话）'
    : d.autoTitle ? '想聊什么，直接说' : '接着讨论，或说“把改动交给电脑”';
  const localFiles = d.wxFiles ?? [], selectedFiles = localFiles.filter(f => f.selected);
  const currentModel = ui.settings.model || 'deepseek-flash', effort = ui.settings.effort || 'high';
  const modelName = currentModel === 'deepseek-flash' ? 'V4.1 Flash' : currentModel === 'deepseek-v4-pro' ? 'V4 Pro' : currentModel;
  const labelEffort = { none: '不思考', low: 'Low', high: 'High', max: 'Max' };
  const modelShort = currentModel === 'deepseek-flash' ? 'Flash' : currentModel === 'deepseek-v4-pro' ? 'Pro' : currentModel;
  const modelChip = button(ic('spark', 'xs') + esc(modelShort), 'sheet', 'setup', 'c-model');
  const wechatChip = (ui.incoming.length ? button('待归入 ' + ui.incoming.length + ' 批', 'open-inbox', '', 'chip') : '') +
    (localFiles.length ? button('已收 ' + localFiles.length + ' 份 · 本轮 ' + selectedFiles.length + ' 份', 'sheet', 'received', 'chip') : '');
  const suggestions = life ? [['明早 8 点提醒我带伞', '明早 8 点提醒我带伞'], ['周末去哪走走', '周末有什么适合散步的地方？']]
    : [['帮我起草周报开头', '帮我起草一段简短的周报开头'], ['查一下最新消息', '查一下今天的科技新闻']];
  const starters = isHome && !d.messages.length ? `<div class="home-suggestions">
    ${suggestions.map(([label, value]) => button(label, 'fill-composer', value, 'chip')).join('')}</div>` : '';
  const composer = `<form class="composer-wrap" data-form="send">${starters}<div class="composer">
    ${wechatChip || leadCtx ? '<div class="composer-materials">' + wechatChip + leadCtx + '</div>' : ''}
    <textarea id="composer" class="c-in" name="message" rows="${d.input.includes('\n') ? 2 : 1}" placeholder="${placeholder}" aria-label="消息" maxlength="14000" enterkeyhint="send">${esc(d.input)}</textarea>
    <div class="c-row">${icon('plus', '更多操作', 'sheet', 'add', 'c-btn')}${modelChip}<span class="c-sp"></span>
    <button class="c-note" type="button" data-act="note-save-or-capture" aria-label="记一笔">${ic('pen', 'sm')}<span>记一笔</span></button>
    <button class="send c-send" type="submit" aria-label="${ui.online ? '发送' : '存草稿'}" ${!d.input.trim() || ui.busyDialogs.has(d.id) ? 'disabled' : ''}>${ic('up')}</button></div></div></form>`;
  const discHead = `<header class="topbar">${back}<div class="title"><h1>${esc(d.title)}</h1><div class="sub">${tagFor(d)}<span>${esc(origin(d))}</span></div></div>${topStatus(true)}${canAttach ? icon('folder', '挂到项目', 'sheet', 'attachproj') : ''}${icon('more', '关联与决定', 'sheet', 'links')}</header>`;
  const gaps = !d.peer ? '' : `<div class="sysline${!d.history || d.history.gap ? ' gap' : ''}">${esc(d.history?.at ? '最近记录 · 同步于 ' + when(d.history.at) + (d.history.gap ? ' · 早期正文未同步' : '') : '尚无同步正文，只显示已保存的记录')}</div>`;
  const fresh = !isHome && d.autoTitle && !d.messages.length
    ? `<div class="welcome">${art('phone-assistant')}<b>新对话</b></div>` : '';
  const middle = isHome ? (d.messages.length ? '' : hero(false) + setup + (homeItems.length ? '<div class="agenda">' + homeItems.join('') + '</div>' : '')) : fresh + gaps + issue(d.historyError || d.syncError) +
    (conflict ? card(head('decision', '这项决定在两处被改过', '选择要沿用的版本') + button('核对决定', 'conflict', d.id, 'primary')) : '') +
    decisions(d).filter((x) => x.heads.length === 1).map((x) => {
      const v = x.versions.find((v) => v.version === x.heads[0]);
      return `<div class="msg card"><div class="decision">${art('decision')}<div class="t">已记下决定：${esc(v.text)}<small>引用你的原话 · 只用于这场讨论 · 未派工</small></div>${icon('edit', '修改决定', 'decision', x.id)}</div></div>`;
    }).join('');
  const modeSwitch = `<div class="mode-switch" role="group" aria-label="模式">${[[LIFE, '生活', 'sun'], [WORK, '工作', 'brief']].map(([id, label, glyph]) =>
    `<button type="button" data-act="change-mode" data-v="${id}" aria-pressed="${ui.mode === id}">${ic(glyph, 'xs')}${label}${life && id === WORK && hasPendingWork ? '<span class="mode-pip" role="img" aria-label="有工作待处理"></span>' : ''}</button>`).join('')}</div>`;
  const homeHead = `<header class="topbar home-bar">${icon('menu', '打开菜单', 'sheet', 'drawer')}${modeSwitch}
    ${life ? icon('bell', '提醒', 'go-reminders') : icon('bell', unreadWorkCount ? '待处理，' + unreadWorkCount + ' 条未读' : '待处理', 'sheet', 'pending', '',
      unreadWorkCount ? `<span class="work-unread-count" aria-hidden="true">${unreadWorkCount > 99 ? '99+' : unreadWorkCount}</span>` : '')}</header>`;
  const lookup = () => {
    const q = ui.query.trim().toLowerCase();
    const all = dialogs.filter((x) => !q || [x.title, origin(x), ...x.messages.slice(-5).map((m) => m.text),
      ...(x.history?.messages ?? []).slice(-5).map((m) => m.text)].some((s) => s.toLowerCase().includes(q)));
    const sessionRow = (x) => `<button class="s-row" data-act="open" data-v="${esc(x.id)}">${art(kind[x.kind][1])}<div class="t"><b>${esc(x.title)}</b><span>${tagFor(x)} ${esc(origin(x))}${x.peer && (!x.history || x.history.gap) ? '<span class="tag gap">有缺口</span>' : ''}</span></div><time>${esc(when(x.used || x.listedAt))}</time></button>`;
    const group = (label, items) => items.length ? `<div class="group-h"><span>${esc(label)}</span></div><div class="s-group">${items.map(sessionRow).join('')}</div>` : '';
    const keys = [...new Set(all.map((d) => d.project ?? ''))].sort((a, b) => (a === '') - (b === ''));
    const results = life || ui.tab === 'recent' ? group(life ? '' : '按你最后使用排序', all.filter((x) => x.kind === 'home' || x.used).sort((a, b) => b.used - a.used))
      : ui.tab === 'kind' ? Object.keys(kind).map((k) => group(kind[k][0], all.filter((x) => x.kind === k))).join('')
      : keys.map((k) => group(k ? origin({ project: k, peer: data.projects[k].peer }) : '未归类', all.filter((x) => (x.project ?? '') === k))).join('');
    const info = peers.map((p) => data.peers[p.id]).filter(Boolean).map((p) => p.issue || (p.catalogIssue ?? []).join('；')).filter(Boolean);
    return `<header class="topbar">${back}<div class="title"><h1>找会话</h1><div class="sub">${life ? '生活 · 只在手机' : '和总管用同一份索引' + (data.last ? ' · 同步于 ' + esc(when(data.last)) : '')}</div></div>${topStatus()}</header>
      <label class="search-field">${ic('search', 'sm')}<input id="sess-q" placeholder="${life ? '搜生活对话' : '搜标题、项目或最近主题'}" value="${esc(ui.query)}"></label>
      ${life ? '' : `<div class="tabs" role="tablist">${[['project', '项目'], ['recent', '最近'], ['kind', '分类']].map(([v, name]) => `<button role="tab" aria-selected="${ui.tab === v}" data-act="tab" data-v="${v}">${name}</button>`).join('')}</div>`}
      <div class="list-toolbar">${button('新讨论', 'sheet', 'new', 'ghost')}${peers.length ? button(ui.syncing ? '同步中…' : '同步会话', 'sync') : ''}</div>
      <div class="list">${results || `<div class="empty">${art('find-sessions')}没有找到会话。<br>仅搜索已保存的标题和摘录。</div>`}${info.length ? foot(esc(info.join('；'))) : ''}</div>`;
  };
  const screen = ui.screen === 'sessions' ? lookup() : (isHome ? homeHead + (d.messages.length ? hero(true) : '') : discHead) +
    legacyBanner + banner + `<div class="stream${isHome && !d.messages.length ? ' home-empty' : ''}">${middle}${conversation}</div>` + composer;
  if (reminderOverlay) return screen + renderReminderOverlay();
  if (memoryOverlay) return screen + renderMemoryOverlay();
  const sh = ui.sheet;
  if (!sh) return screen;
  const x = data.dialogs[sh.dialog ?? ui.current];
  const w = data.work[sh.value];
  const sheet = (title, body, cls = '') => screen + wrap(title, body, sh.error, cls);
  if (!life && ['shared-delivery', 'shared-delivery-file'].includes(sh.type)) {
    if (!sharedDeliveries(data).some(item => item.id === sh.id && item.peer === sh.peer))
      return sheet('成果不可用', foot('连接电脑后刷新，或核对项目是否仍在共享。'));
    const { result } = sh;
    return sheet('电脑发来的成果', card(head('receipt', result.title ?? result.name, result.revision ? '第 ' + result.revision + ' 版' : '') +
      `<div class="reading">${reading(result.text)}</div>` + (result.textTruncated ? foot('仅展示前段正文。') : '') +
      (result.artifacts ?? []).map(f => choice('receipt', f.name, '文本产物', 'shared-delivery-file', JSON.stringify([sh.peer, sh.id, f.id]))).join('')));
  }
  const projects = Object.values(data.projects).filter((p) => p.shared && peers.some((x) => x.id === p.peer));
  const projectOptions = (none, selected) => option('', none, !selected) + projects.map((p) =>
    option(p.key, p.name + ' · ' + data.peers[p.peer]?.name, p.key === selected)).join('');
  if (sh.type === 'drawer') {
    const inbox = notesState(ui).counts.inbox;
    const nav = (glyph, label, action, value = '', trailing = '') => `<button type="button" class="dr-row" data-act="${action}" data-v="${esc(value)}">
      ${ic(glyph)}<b>${esc(label)}</b>${trailing ? '<small>' + esc(trailing) + '</small>' : ''}</button>`;
    const conv = (id, title, value, glyph) => `<button type="button" class="dr-conv" data-act="open" data-v="${esc(id)}">${ic(glyph, 'sm')}<b>${esc(title)}</b><small>${esc(value)}</small></button>`;
    const recents = dialogs.filter(x => x.kind !== 'home' && (x.used || x.listedAt)).sort((a,b) => (b.used || Date.parse(b.listedAt) || 0) - (a.used || Date.parse(a.listedAt) || 0)).slice(0,5);
    return screen + `<div class="scrim" data-act="close"></div><section class="drawer drawer-v2" role="dialog" aria-modal="true" aria-label="星引">
      <button type="button" class="dr-search" aria-label="找会话" data-act="go" data-v="sessions">${ic('search','sm')}搜对话和笔记</button>
      <div class="dr-new">${button(ic('plus', 'sm') + '新对话', 'new-chat', '', 'primary grow')}${button(ic('pen', 'sm') + '记一笔', 'note-capture', '', 'soft grow')}</div>
      <div class="dr-scroll"><div class="dr-nav">
        ${nav('note','笔记','go-notes','',inbox ? '收件箱 ' + inbox : '')}${nav('bell','提醒','go-reminders')}${nav('memory','记忆','go-memory')}
        ${life ? '' : nav('layers','项目与 Agent','go-agent-projects') + nav('monitor','电脑','sheet','devices',peers.filter(p=>data.peers[p.id]?.online).length + '/' + peers.length + ' 在线')}
        ${nav('shield','助手能力','sheet','permissions')}
      </div><div class="dr-section"><b>${life ? '生活' : '工作'}里的对话</b>${button('全部','go','sessions','text')}</div>
      <div class="dr-convs">${conv(homeId(ui.mode),'总管对话','首页','spark')}${recents.map(x=>conv(x.id,x.title,x.kind === 'discussion' ? when(x.used || x.listedAt) : kind[x.kind][0],x.kind === 'discussion' ? 'note' : 'monitor')).join('')}</div></div>
      <button type="button" class="dr-foot" data-act="sheet" data-v="settings" aria-label="设置"><span class="home-pet">${petCanvas('profile')}</span>
      <span><b>${esc(data.persona.name)}</b><small>设置</small></span>${ic('sliders')}</button></section>`;
  }
  if (sh.type === 'settings') {
    const p = data.persona;
    return sheet('设置', `<button class="settings-profile" data-act="sheet" data-v="persona"><span class="home-pet" aria-hidden="true">${petCanvas('profile')}</span><b>${esc(p.name)}</b>${ic('right', 'sm')}</button>` +
      section('助手', choice('phone-assistant', '模型与 Key', ui.settings.ready ? modelShort : '未接入', 'sheet', 'setup') +
        choice('', '人格与风格', TONES[p.tone][0], 'sheet', 'persona') + choice('memory', '记忆', '', 'go-memory') + choice('permissions', '助手能力', '', 'sheet', 'permissions')) +
      (life ? '' : section('设备', choice('computer-asleep', '电脑', peers.length ? peers.length + ' 台' : '', 'sheet', 'devices') +
        choice('', '工作通知', '', 'work-notice-open'))) +
      section('隐私', choice('app-lock', '应用锁与备份', '', 'privacy-open')), 'settings');
  }
  if (sh.type === 'privacy') {
    const { enabled, available } = sh.value;
    return sheet('应用锁与备份', section('应用锁',
      choice('app-lock', '应用锁', enabled ? '已开启' : '未开启', 'privacy-set-lock', enabled ? 'off' : 'on') +
      (enabled ? button('现在锁上', 'privacy-lock-now') : '') +
      (!available ? foot('请先在系统设置启用锁屏密码。') : '')) +
      section('备份', choice('backup', '导出备份', '', 'backup-export') +
        choice('backup', '从备份恢复', '', 'backup-preview') + foot('文件未加密，不含模型密钥或配对凭据。')), 'privacy');
  }
  if (sh.type === 'backup-review') {
    const labels = [['dialogs', '对话'], ['notes', '笔记'], ['memories', '记忆'], ['reminders', '提醒'], ['files', '附件']];
    if (sh.value.deletedMemories) labels.push(['deletedMemories', '删除标记']);
    return sheet('核对备份', section('备份内记录', card(`<div>${labels.map(([key, label]) => label + ' ' + Number(sh.value[key])).join(' · ')}</div>`)) +
      foot('保留本机记录，按删除标记同步记忆删除；电脑配对和派工不恢复。') +
      row(button('合并备份', 'backup-restore', '', 'primary grow') + button('取消', 'close')));
  }
  if (sh.type === 'persona') {
    const p = data.persona;
    const options = (name, label, items) => `<fieldset class="persona-options"><legend>${label}</legend><div>${items.map(([value, text]) =>
      `<label><input type="radio" name="${name}" value="${value}" ${p[name] === value ? 'checked' : ''}><span>${text}</span></label>`).join('')}</div></fieldset>`;
    return sheet('人格与风格', form('persona',
      field('名字', 'name', p.name, { max: 8, extra: 'required' }) + field('怎么称呼你', 'call', p.call, { max: 8 }) +
      options('tone', '语气', Object.entries(TONES).map(([key, [label]]) => [key, label])) +
      options('length', '详略', Object.entries(LENGTHS)) +
      field('补充说明', 'custom', p.custom, { type: 'textarea', max: 300, placeholder: '比如：少用感叹号' }) +
      section('预览', card(`<p class="persona-preview-copy">${esc(personaPreview(p))}</p><span class="state st-queued">${ic('shield', 'xs')} 电脑已收到，等待执行</span>`)),
      '保存', false), 'persona');
  }
  if (sh.type === 'pending') {
    const items = work.filter((w) => pendingWork(w))
      .sort((a, b) => Number(unreadWork(b)) - Number(unreadWork(a)) || (b.notice?.at ?? b.at).localeCompare(a.notice?.at ?? a.at));
    const cards = [...conflicts.map((x) => agenda('decision', '决定冲突', x.title, '', 'conflict', x.id, true)),
      ...items.map((w) => agenda('handoff', (unreadWork(w) ? '未读 · ' : '') +
        (w.receipt?.question ? '等你回答' : stage[w.stage][0]), w.goal, targetLabel(w),
        w.receipt?.question ? 'question' : 'work', w.id, unreadWork(w)))];
    const incoming = life ? [] : sharedDeliveries(data).sort((a, b) => b.at.localeCompare(a.at));
    return sheet('待处理', (cards.join('') || (!incoming.length ? `<div class="empty">${art('all-clear')}没有待处理事项</div>` : '')) +
      (incoming.length ? section('电脑发来的成果', incoming.map(item => choice('receipt', item.title, '第 ' + item.revision + ' 版',
        'shared-delivery', JSON.stringify([item.peer, item.id]))).join('')) : '') +
      row(button('通知设置', 'work-notice-open', '', 'text')));
  }
  if (sh.type === 'pet-details') {
    const current = life ? [] : work.filter((w) => pendingWork(w));
    return sheet(data.persona.name,
      (current.map((w) => agenda('handoff', stage[w.stage][0], w.goal, targetLabel(w), w.receipt?.question ? 'question' : 'work', w.id)).join('') ||
        `<div class="empty">${art('all-clear')}没有待处理事项</div>`) +
        (life ? '' : row(button('全部待处理', 'sheet', 'pending', 'text'))));
  }
  if (sh.type === 'work-notices') {
    return sheet('工作通知', section('', choice('', '系统通知', data.workNotices !== false ? '已开启' : '已关闭', 'work-notice-toggle') +
      choice('', 'Android 通知设置', sh.value ? '已允许' : '未允许', 'work-notice-system')) +
      foot('手机收到电脑回执后通知。关闭系统通知仍会显示未读。'));
  }
  if (sh.type === 'permissions') {
    const prefs = toolPrefs(data, ui.mode);
    const toggle = (key, glyph, label, title = '') => `<label class="toggle-row" title="${title}">${ic(glyph, 'sm')}<span class="t">${label}</span><input type="checkbox" data-tool="${key}" ${prefs[key] ? 'checked' : ''}></label>`;
    const group = (title, content) => section(title, `<div class="permission-group">${content}</div>`);
    const textRow = (glyph, label, value) => `<div class="toggle-row">${ic(glyph, 'sm')}<span class="t">${label}</span><small>${value}</small></div>`;
    return sheet('助手能力', (!ui.settings.officialSearch ? foot('自动调用工具需要 DeepSeek 官方 Key。') : '') +
      group('联网 · 每次约 ¥0.005', toggle('web_search', 'search', '联网搜索', '允许搜索网页') + toggle('web_fetch', 'link', '读取网页', '允许读取网页正文')) +
      group('本机', toggle('note_search', 'note', '检索笔记') + toggle('note_add', 'pen', '助手记一笔') + toggle('reminders', 'bell', '提醒工具') + toggle('memory', 'memory', '记忆')) +
      group('系统权限', textRow('wifi', '网络和连接状态', '已允许') +
        textRow('bell', '通知', ui.reminderPermissions?.notifications ? '已允许' : '未开启') +
        textRow('clock', '精确定时', ui.reminderPermissions?.exact ? '已允许' : '未开启') + textRow('image', '定位、相机与相册', '未申请') +
        textRow('mic', '麦克风', '未申请')) +
      group('始终由你决定', textRow('trash', '删除', '') + textRow('monitor', '交给电脑', '') + textRow('shield', '读过资料后的写入', '')), 'permissions');
  }
  if (sh.type === 'setup') return sheet('接入 DeepSeek', lead('接入后手机直连 DeepSeek，电脑全关也能对话和起草。配对电脑可以以后再说。') + form('setup',
    field('API Key', 'key', '', { type: 'password', max: 4000, placeholder: ui.settings.ready ? '留空可保留现有密钥' : '粘贴你的 DeepSeek API Key' }) +
    select('模型', 'preset', option('deepseek-flash', 'DeepSeek V4.1 Flash', currentModel === 'deepseek-flash') +
      option('deepseek-v4-pro', 'DeepSeek V4 Pro', currentModel === 'deepseek-v4-pro') +
      option('custom', '自定义模型', !['deepseek-flash', 'deepseek-v4-pro'].includes(currentModel))) +
    `<label class="field" ${['deepseek-flash','deepseek-v4-pro'].includes(currentModel) ? 'hidden' : ''}>自定义模型名<input name="model" maxlength="120" value="${esc(currentModel)}"></label>` +
    select('思考强度', 'effort', Object.entries(labelEffort).map(([key, label]) => option(key, label, key === effort)).join('')) +
    `<details ${ui.settings.ready ? 'open' : ''}><summary>模型与网关</summary>${field('HTTPS Chat Completions 地址', 'endpoint', ui.settings.endpoint || 'https://api.deepseek.com/chat/completions', { max: 400, extra: 'required' })}</details>` +
    foot(ic('shield', 'xs') + ' 密钥由 Android 系统密钥库保护，只用于手机请求。') +
    foot('费用按 ' + PRICE_DATE + ' 公布单价估算，实际以开放平台账单为准。'), '保存并开始', sh.busy) +
    (ui.settings.ready ? button('移除 DeepSeek 凭据', 'clear-model', '', 'text') : ''));
  if (sh.type === 'devices') return sheet('电脑', lead('需要电脑时，总管会在对话里告诉你在等哪台。') + section('已配对电脑', peers.map((p) => {
    const item = data.peers[p.id];
    return `<div class="dev"><img src="${A(item?.online ? 'handoff' : 'computer-asleep')}" alt="" width="34" height="34"><div class="t"><b>${esc(p.name)}</b><span>${item?.online ? '在线' : '未连接' + (item?.at ? ' · 最后连接 ' + when(item.at) : '')}</span><span>${esc(item?.issue)}</span></div>${button('移除', 'unpair', p.id, 'text')}</div>`;
  }).join('') || foot('还没有配对电脑。')) + section('手机侧',
    choice('phone-assistant', 'DeepSeek', ui.settings.ready ? '手机直连 · 管理配置' : '未接入', 'sheet', 'setup') +
    choice('search-source', '联网搜索', ui.settings.officialSearch ? 'DeepSeek 官方 · 沿用模型 Key' :
      ui.settings.search ? 'Brave Search · 已配置' : '未配置搜索凭据', ui.settings.officialSearch ? 'search-query' : 'sheet', 'search')) +
    row(button(ic('plus', 'sm') + ' 配对一台电脑', 'sheet', 'pair', 'primary grow') + (peers.length ? button('刷新', 'sync') : '')));
  if (sh.type === 'pair') return sheet('配对一台电脑', lead('同一局域网 · 桌面「连接手机」') +
    row(`<button type="button" class="btn ghost grow" data-act="pair-scan" ${sh.scanBusy || sh.busy ? 'disabled' : ''}>${sh.scanBusy ? '正在打开扫码…' : '扫一扫'}</button>`) +
    (sh.scanReady ? '<p class="foot-note" role="status" data-pair-scan-ready>已填入配对码，点「配对」继续。</p>' : '') +
    form('pair', field('配对码', 'code', sh.code ?? '', { type: 'textarea', max: 2000, placeholder: '扫码或粘贴配对码',
      extra: `required autocapitalize="none" spellcheck="false"${sh.scanBusy ? ' readonly' : ''}` }),
      '配对', sh.busy || sh.scanBusy, button('取消', 'close', '', 'text')), 'transfer-sheet');
  if (sh.type === 'search') return sheet('接入联网搜索', lead('如果使用 DeepSeek 官方服务，同一把 Key 就能联网搜索。自定义网关可以另配 Brave Search。') +
    button('使用 DeepSeek 官方 Key', 'sheet', 'setup') +
    form('search', field('Brave Search API Key', 'key', '', { type: 'password', max: 4000, placeholder: '粘贴 API Key', extra: 'required' }), '保存搜索配置', sh.busy) +
    (ui.settings.search && !ui.settings.officialSearch ? button('移除搜索凭据', 'clear-search', '', 'text') : ''));
  if (sh.type === 'add') {
    const tile = (image, title, action, value = '') => button(art(image) + '<b>' + esc(title) + '</b>', action, value, 'add-tile');
    return sheet('添加', `<div class="add-grid">
      ${tile('album','相册','pick-files','photos')}${tile('link-read','本机文件','pick-files','files')}
      ${tile('note','笔记','go-notes')}${tile('find-sessions','找会话','go','sessions')}${tile('search-source','联网搜索','search-query')}
      </div><p class="add-hint">${ic('shield','xs')}发送后才离开手机</p>` +
      row((life ? button('新对话','new-chat','','text') : button('新讨论','sheet','new','text') + button('准备交接','draft-work','','text')) +
        (isHome ? '' : button('记下决定','decision','','text'))), 'add-sheet');
  }
  if (sh.type === 'import') {
    const batch = ui.incoming.find((entry) => entry.id === sh.value);
    const targets = [...dialogs].sort((a, b) => (b.used || 0) - (a.used || 0));
    return sheet('选择接收讨论',
      lead('文件已存在手机，归入时可以选新讨论。') +
      foot(batch.files.map((f) => esc(f.name)).join('、')) +
      form('import', select('放到', 'target', option('', '请选择讨论', !sh.target) +
        option(':new', '新建一场文件讨论', sh.target === ':new') +
        targets.map((t) => option(t.id, t.title + (t.project ? ' · ' + origin(t) : ''), t.id === sh.target)).join('')),
      '归入讨论', sh.busy) +
      row(button('稍后归入', 'close', '', 'text') + button('丢弃这批', 'discard-inbox', '', 'text danger')));
  }
  if (sh.type === 'received-error') return sheet('文件未收到', lead(esc(sh.reason)) + row(button('关闭', 'close')));
  if (sh.type === 'received') return sheet('收到文件', lead(esc(d.title) + ' · 已收 ' + localFiles.length + ' 份') +
    localFiles.map(f => section('', `<label class="toggle-row"><input type="checkbox" data-wx-ref="${esc(f.ref)}" ${f.selected ? 'checked' : ''}><b>${esc(f.name)}</b></label>` +
      foot(esc(f.mime || '文件') + ' · ' + f.size + ' 字节') +
      row(button('打开副本', 'local-preview', f.ref) + button('移除', 'file-remove', f.ref, 'text')))).join('') +
    foot('文件已存手机。下方提问会把勾选的材料交给 ' + esc(modelName) + ' / ' + labelEffort[effort] + '。') +
    row(button('整理成 Markdown', 'file-prompt', '请把勾选的材料整理成 Markdown。', 'primary') +
        button('总结要点', 'file-prompt', '请总结勾选材料的要点。')) +
    form('file-ask', field('自定义要求', 'message', d.input, { type: 'textarea', max: 14000, extra: 'required' }), '带材料发送', false) +
    row(button('放进新讨论', 'file-new') + button('回到讨论', 'close')));
  if (sh.type === 'local-text') return sheet(sh.file.name, '<div class="receipt-result">' + esc(sh.file.text) + '</div>' + row(button('回到收件', 'sheet', 'received')));
  if (sh.type === 'search-query') return sheet('联网搜索', form('search-query',
    field('想查什么', 'query', '', { max: 400, extra: 'required' }), '搜索', sh.busy));
  if (sh.type === 'rename') return sheet('改名', form('rename',
    field('标题', 'title', x.title, { max: 100, extra: 'required' }), '保存', sh.busy));
  if (sh.type === 'new') return sheet('开一场新讨论', form('new',
    field('讨论标题', 'title', '', { max: 100, extra: 'required' }) +
    (life ? '' : select('项目', 'project', projectOptions('先在手机讨论', x.project))), '开始讨论', sh.busy));
  if (sh.type === 'context') return sheet('本轮交给模型的材料', lead('只有勾选的内容会连同本轮问题交给 DeepSeek。') +
    [['talk', '当前讨论 · 预算内历史', '手机消息和同步的讨论正文；超出预算时整理成前情摘要'],
      ['decision', '决定', chosen(d) ? '使用这场讨论已选的决定' : '没有可用的决定'],
      ['native', '原生会话摘录', d.refer || d.session ? '选择后的已同步记录；缺失正文不会补写' : '没有关联原生会话']]
      .map(([key, title, sub]) => `<label class="toggle-row"><div class="t">${title}<small>${sub}</small></div><input type="checkbox" data-context="${key}" ${ui.context(d)[key] ? 'checked' : ''}></label>`).join('') +
    row(button('好', 'close', '', 'primary grow')));
  if (sh.type === 'links') {
    const linked = data.dialogs[x.refer] ?? Object.values(data.dialogs).find((e) => e.kind === x.session?.backend &&
      e.project === x.project && e.session?.threadId === x.session?.threadId && e.session?.source === x.session?.source && e.id !== x.id);
    return sheet('这场讨论关联的', (x.kind === 'discussion' && !x.project ? section('', row(button(ic('pen', 'sm') + ' 改名', 'rename', '', 'ghost grow'))) : '') +
      (canAttach ? section('项目', button(ic('folder', 'sm') + ' 挂到项目', 'sheet', 'attachproj', 'ghost')) : '') +
      (life ? '' : section('原会话', linked ? choice(kind[linked.kind][1], linked.title, kindLabel(linked) + ' · ' + origin(linked), 'open', linked.id) : foot('没有其他关联会话。'))) +
      section('上下文', (activeSummary(x) ? button('查看前情摘要', 'summary', '', 'ghost') : '') +
        (!x.peer && x.messages.filter((m) => !covered.has(m.id) && m.text?.trim()).length > 3 ? button('压缩到这里', 'compress-now', '', 'ghost') : '') ||
        foot('内容不多，不需要压缩。')) +
      section('决定', button('记下决定', 'decision')) + (life ? '' : section('交给电脑的', work.filter((w) => w.dialog === x.id)
        .map((w) => choice('handoff', w.goal || '待填写的交接', w.stage === 'draft' ? '草稿' : stage[w.stage][0], w.stage === 'draft' ? 'edit-work' : 'work', w.id)).join('') ||
        foot(x.project ? '还没有。' : '挂到项目以后才能交给电脑。'))) +
      (x.project ? row(button('交给电脑', 'new-work', '', 'ghost grow')) : ''));
  }
  if (sh.type === 'attachproj') {
    return sheet('挂到项目', lead('之后的消息会同步到那台电脑，<b>之前的不会</b>。') +
      (attachable.length ? attachable.map((p) => `<button class="choice" data-act="attach-project" data-v="${esc(p.key)}">${ic('folder', 'sm')}<div class="t"><b>${esc(p.name)}</b><span>${esc((data.peers[p.peer]?.name ?? '电脑') + (data.peers[p.peer]?.online ? ' · 在线' : ' · 离线'))}</span></div>${ic('right', 'sm')}</button>`).join('')
        : foot('还没有同步到手机的项目。')) +
      foot('挂上以后才出现「交给电脑」。'));
  }
  if (sh.type === 'summary') {
    const record = activeSummary(x);
    if (!record) return sheet('前情摘要', foot('这场对话还没有摘要。'));
    const originals = coveredMessages(x, record).filter((m) => m.text?.trim());
    return sheet('前情摘要', `<div class="card"><div class="n-label">第 1–${record.count} 条 · 第 ${record.version} 版</div><p class="n-text">${esc(record.text)}</p></div>` +
      (sh.original
        ? `<div class="summary-originals">${originals.map((m) => `<div class="summary-original"><small>${esc(m.role === 'user' ? '你' : m.role === 'assistant' ? '星引' : '记录')} · ${esc(when(m.at))}</small><p>${esc(m.text)}</p>${noteAction(m)}</div>`).join('')}</div>` +
          row(button('收起原文', 'summary-original', '', 'ghost grow'))
        : row(button('查看被压缩的原文', 'summary-original', '', 'ghost grow'))) +
      row(button('带摘要开新对话', 'summary-branch', '', 'primary grow')));
  }
  if (sh.type === 'decision') {
    const record = decisions(x).find((r) => r.id === sh.value);
    const old = record?.versions.find((v) => v.version === record.heads[0]);
    return sheet(record ? '修改决定' : '记下决定', lead('只留在这场讨论。之后明确交给电脑时，可以随同这项工作发送。') +
      form('decision', field('决定内容', 'text', old?.text ?? sh.text, { type: 'textarea', max: 14000, extra: 'required' }), '记下决定', sh.busy));
  }
  if (sh.type === 'conflict') {
    const conflict = decisions(x).find((d) => d.heads.length > 1);
    return sheet('这项决定在两处被改过', lead(esc(x.title) + ' · 只需选冲突的这一项。未选的版本会保留在历史。') +
      `<div class="conflict">${conflict.heads.map((h) => conflict.versions.find((v) => v.version === h)).map((v) =>
        choice(v.origin === '电脑' ? 'exec-codex' : 'phone-assistant', v.text,
          [v.origin, when(v.at), v.quote && '原话「' + compact(v.quote) + '」'].filter(Boolean).join(' · '), 'resolve', v.version)).join('')}</div>` +
      foot('选择前，交接不会使用这项决定。'));
  }
  if (sh.type === 'edit-work') {
    const project = sh.project ?? w.project;
    const original = w.target?.threadId && Object.values(data.dialogs).find((a) => a.project === project &&
      a.kind === w.target.backend && a.session?.threadId === w.target.threadId && a.session?.source === w.target.source);
    const selected = sh.target ?? (w.target && (w.target.threadId ? 'native:' + (original?.id ?? x.id) : w.target.backend));
    const known = Object.values(data.dialogs).filter((a) => a.project === project && (a.kind === 'codex' || a.kind === 'dsh') && a.listed !== false);
    if (x.session && x.project === project && !known.some((a) => a.session.threadId === x.session.threadId && a.session.source === x.session.source)) known.unshift(x);
    const options = option('', '选择执行端与会话', !selected) + known.map((a) => {
      const value = 'native:' + a.id;
      return option(value, kind[a.session.backend][0] + ' 原会话 · ' + a.title, value === selected);
    }).join('') + ['dsh', 'codex'].map((k) => option(k, '新建 ' + kind[k][0] + ' 托管工作', selected === k)).join('');
    const target = selected?.startsWith('native:') ? data.dialogs[selected.slice(7)]?.session
      : selected ? { backend: selected } : undefined;
    const materials = (x.wxFiles ?? []).map((f) => `<label class="toggle-row"><div class="t">${esc(f.name)}<small>${materialLabel(f, materialMode(f, target))}</small></div>
      <input type="checkbox" name="material" value="${esc(f.ref)}" ${(sh.refs ?? w.refs ?? []).includes(f.ref) ? 'checked' : ''}></label>`).join('');
    return sheet('发往哪里', lead('继续已有工作优先交回原会话，两个端点不自动互换。') +
      form('edit-work', select('项目', 'project', projectOptions('选择共享项目', project)) + select('发往', 'target', options) +
        (selected?.startsWith('native:') ? foot('权限 · 沿用原会话') : select('权限', 'mode', option('write', '项目内写入', (sh.mode || w.target?.mode) !== 'read') + option('read', '项目内只读', (sh.mode || w.target?.mode) === 'read'))) +
        field('做什么', 'goal', sh.goal ?? w.goal, { type: 'textarea', max: 10000, extra: 'required' }) +
        field('验收', 'acceptance', sh.acceptance ?? w.acceptance, { type: 'textarea', max: 3000, extra: 'required' }) +
        (materials ? section('随任务发送的材料（最多 3 份）', materials) : ''), '保存交接草稿', sh.busy));
  }
  if (sh.type === 'work') return sheet(w.goal, lead(status(w) + '　请求 ' + esc(w.id)) + taskInfo(w) + materialReceipt(w.receipt) +
    section('回执（按收到的证据记录）', `<ul class="timeline">${w.log.map((l) =>
      `<li class="${l.stage === 'failed' ? 'bad' : l.stage === 'verify' ? 'warn' : ''}">${esc(l.detail)}<small>${esc(when(l.at))}</small></li>`).join('')}</ul>`) +
    (w.receipt?.text ? `<div class="receipt-result reading">${reading(w.receipt.text, true)}</div>` : '') +
    (w.receipt?.diff ? `<div class="diff">${esc(w.receipt.diff)}</div>` : '') +
    artifacts(w) +
    (w.receipt?.text ? row(button('导出结果', 'export-work', w.id)) : '') +
    row(button('回到原讨论', 'open', w.dialog, 'ghost grow') + (w.stage === 'review' && w.receipt?.evidenceHash ? acceptResult(w, '验收') : '') +
      (w.stage === 'failed' ? button('核对后重新准备', 'retry-work', w.id) : '')));
  if (sh.type === 'artifact') return sheet(sh.artifact.name, (sh.artifact.cached ? foot('手机已存副本 · 保存于 ' + esc(when(sh.artifact.at))) : '') +
    (/\.(?:md|markdown)$/i.test(sh.artifact.name)
    ? `<div class="receipt-result reading">${reading(sh.artifact.text, true)}</div>` : `<div class="receipt-result">${esc(sh.artifact.text)}</div>`) +
    row(button('回到回执', 'work', w.id, 'ghost grow') + button('复制正文', 'copy-artifact') + button('导出产物', 'export-artifact')));
  if (sh.type === 'export') return sheet('导出成果', lead(esc(sh.value.title)) +
    foot(sh.outline ? '保存和分享使用同一份逐页大纲。' : '保存和分享使用同一份 Markdown，正文后附出处。') +
    row(button('保存 .md', 'export-save', '', 'primary grow') + button('系统分享', 'export-share', '', 'ghost grow')) +
    row(button('复制导出内容', 'export-copy', '', 'text') + (sh.back ? button('返回', 'export-back', '', 'text') : '')));
  if (sh.type === 'question') {
    const q = w.receipt?.question;
    return sheet('执行端在等你回答', lead(esc(w.goal)) + (q ? form('question', q.fields.map((f) => f.options.length
      ? select(esc(f.question), esc(f.id), f.options.map((o) => option(o, o, false)).join(''))
      : field(esc(f.question), esc(f.id), '', { max: 3000, extra: 'required' })).join(''), '回答', sh.busy) : foot('这条问题已变化，请先同步。')));
  }
  if (sh.type === 'diagram') return sheet('架构图', row(button('缩小', 'diagram-zoom', 'out') +
    `<span data-diagram-scale aria-live="polite">${sh.zoom * 100}%</span>` + button('放大', 'diagram-zoom', 'in')) + diagramMarkup(sh.source, true, sh.zoom) +
    row(button('复制源码', 'diagram-copy') + button('保存 PNG', 'diagram-save', '', 'primary') + button('分享 PNG', 'diagram-share')), 'sheet-diagram');
  if (sh.type === 'slides') {
    const slide = slidesSheet(sh.deck, sh.index);
    return sheet(slide.title, slide.body, 'slides-sheet');
  }
  return screen;
}
