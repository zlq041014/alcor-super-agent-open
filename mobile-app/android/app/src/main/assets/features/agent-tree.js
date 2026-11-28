import { A, esc, ic } from '../icons.js';
import { decisions, listDialogs } from '../model.js';
import { WORK } from './modes.js';

const labels = {
  discussion: '讨论', draft: '草稿', ready: '待执行', active: '已启动', starting: '启动中',
  running: '执行中', waiting_approval: '待授权', waiting_input: '待回答', unknown: '待核对',
  blocked: '已阻塞', paused: '已暂停', verifying: '待验收', done: '已完成', cancelled: '已取消',
};
const backend = { codex: 'Codex', dsh: 'DSH' };
const time = (at) => at ? new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const btn = (label, act, value = '', style = 'ghost') =>
  `<button type="button" class="btn ${style}" data-act="${act}" data-v="${esc(value)}">${label}</button>`;
const row = (title, meta, act, value) => `<button type="button" class="reminder-row agent-row" data-act="${act}" data-v="${esc(value)}">
  <span><b>${esc(title)}</b><small>${esc(meta)}</small></span>${ic('right','sm')}</button>`;
const head = (title, back, sub = '', right = '') => `<header class="topbar"><button class="icon-btn" data-act="${back}" aria-label="返回">${ic('back')}</button>
  <div class="title"><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>${right}</header>`;
const empty = (text) => `<div class="empty"><img src="${A('agent-tree')}" alt=""><b>${text}</b></div>`;

function tree(nodes, collapsed) {
  const byId = new Map(nodes.map((n) => [n.id, n])), children = new Map();
  for (const node of nodes) {
    const parent = byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(node);
  }
  const seen = new Set(), html = [];
  function add(node, depth, hidden) {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    const group = children.get(node.id) ?? [], folded = collapsed.has(node.id);
    if (!hidden) html.push(`<div class="agent-branch depth-${Math.min(depth, 4)}">
      ${group.length ? `<button type="button" class="icon-btn agent-fold" data-act="agent-fold" data-v="${esc(node.id)}" aria-expanded="${!folded}"
        aria-label="${folded ? '展开' : '折叠'} ${esc(node.title)}">${ic('right','xs')}</button>` : '<span class="agent-fold"></span>'}
      ${row(node.title, [backend[node.backend], labels[node.state] ?? '未知', time(node.at)].filter(Boolean).join(' · '), 'agent-detail', node.id)}</div>`);
    for (const child of group) add(child, depth + 1, hidden || folded);
  }
  for (const node of children.get(null) ?? []) add(node, 0, false);
  for (const node of nodes) if (!seen.has(node.id)) add(node, 0, false);
  return html.join('');
}

export function sharedProjects(data, peers) {
  const paired = new Set(peers.map((p) => p.id));
  return Object.values(data.projects).filter((p) => p.shared && paired.has(p.peer));
}

export function agentScreen(data, ui) {
  const projects = sharedProjects(data, ui.settings.peers);
  const p = projects.find((p) => p.key === ui.agentProject);
  if (ui.screen !== 'agent-project' || !p) {
    const rows = projects.map(p => row(p.name, [data.peers[p.peer]?.name, data.peers[p.peer]?.online ? '在线' : '离线'].filter(Boolean).join(' · '), 'agent-project', p.key));
    return head('项目与 Agent', 'go-home') + `<div class="list agent-list">${rows.join('') || empty('没有共享项目')}</div>`;
  }
  const cached = data.agentTrees?.[p.key];
  const online = ui.online && data.peers[p.peer]?.online;
  const tab = ui.agentTab;
  let content;
  if (tab === 'tree') content = cached?.nodes.length ? tree(cached.nodes, ui.agentCollapsed) : empty(cached ? '没有 Agent 节点' : '暂无结构');
  else {
    const contexts = listDialogs(data, WORK).filter(d => d.project === p.key && d.kind === 'discussion');
    content = tab === 'chats' ? contexts.map(d => row(d.title, time(d.used || d.listedAt), 'open', d.id)).join('') || empty('还没有对话')
      : contexts.flatMap(d => decisions(d).map(r => row(r.heads.length > 1 ? '两处都改过' :
        r.versions.find(v => v.version === r.heads[0])?.text ?? '决定', d.title, 'open', d.id))).join('') || empty('还没有决定');
  }
  return head(p.name, 'go-agent-projects', data.peers[p.peer]?.name ?? '', btn(ui.agentLoading ? '读取中' : '刷新', 'agent-refresh')) +
    `<div class="tabs" role="tablist">${[['tree','结构'],['chats','对话'],['decisions','决定']].map(([id, label]) =>
      `<button role="tab" aria-selected="${tab === id}" data-act="agent-tab" data-v="${id}">${label}</button>`).join('')}</div>
      <div class="list agent-list">${tab === 'tree' && (cached || !online || ui.agentError) ?
        `<div class="foot-note">${!online ? '电脑离线' : ui.agentError ? esc(ui.agentError) : '已同步'}${cached ? ' · ' + esc(time(cached.at)) + (cached.truncated ? ' · 最近 250 项' : '') : ''}</div>` : ''}
        ${content}</div>`;
}

export function agentDetails(data, key, node) {
  if (!data.projects[key]?.shared || !node) return null;
  const nodes = data.agentTrees[key].nodes;
  const parent = nodes.find(n => n.id === node.parentId);
  const related = node.discussionId ? node : parent?.discussionId ? parent : null;
  const work = data.work[node.workId];
  return { title: node.title, body: `<p class="lead">${esc([labels[node.state] ?? '未知', backend[node.backend], node.model, time(node.at)].filter(Boolean).join(' · '))}</p>
    ${node.roster ? `<p class="foot-note">${node.roster.recorded ? '手动关联' : '承办 Agent'}：${esc(node.roster.name)}</p>` : ''}
    <div class="row-btns">${related ? btn(related === node ? '查看讨论' : '上级讨论', 'agent-open-chat', related.id) : ''}
    ${node.session ? btn('原会话', 'agent-open-session', node.id) : ''}${work?.project === key ? btn('查看回执', 'agent-open-work', work.id) : ''}</div>
    ${node.session ? btn('设为交接目标', 'agent-target', node.id, 'primary') : '<p class="foot-note">没有可接续的原会话。</p>'}` };
}
