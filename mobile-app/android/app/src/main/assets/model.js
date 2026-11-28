import { DEFAULT_TOOL_PREFS } from './features/tools.js';
import { DEFAULT_PERSONA } from './features/persona.js';
import { LIFE, WORK, dialogMode, homeId, inMode } from './features/modes.js';
import { recordWorkNotice } from './features/work-notices.js';

const host = window.AlcorNative;
const pending = new Map();
let lastSaved = '';
let fallback = false;
let fallbackIssue = '';
export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const desktopKey = (peer, id) => JSON.stringify([peer, id]);
// The native database owns conversation state; the legacy file is used only while a migration fails.
export const stateIssue = () => fallbackIssue;

window.alcorResult = (id, kind, value) => {
  const call = pending.get(id);
  if (!call) return;
  if (kind === 'delta') { call.delta?.(value); return; }
  pending.delete(id);
  if (kind === 'done') call.resolve(value);
  else call.reject(new Error(value));
};
export function native(op, value = {}, delta) {
  const id = uid();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, delta });
    host.request(id, op, JSON.stringify(value));
  });
}

export function load() {
  let stored;
  if (typeof host.state === 'function') {
    const value = host.state();
    if (value.startsWith('~')) {
      fallback = true;
      fallbackIssue = value.slice(1);
      stored = host.read();
    } else if (value.startsWith('!')) throw new Error(value.slice(1));
    else stored = value;
  } else {
    fallback = true;
    fallbackIssue = '当前页面没有原生记录库，先继续使用旧记录文件';
    stored = host.read();
  }
  if (stored.startsWith('!')) throw new Error(stored.slice(1));
  lastSaved = stored;
  const data = stored ? JSON.parse(stored) : {
    dialogs: { home: { id: 'home', kind: 'home', title: '星引总管', messages: [], input: '', used: 0 } },
    projects: {}, peers: {}, work: {}, last: '',
  };
  for (const w of Object.values(data.work)) {
    if (w.stage === 'sending') w.stage = 'verify';
    if (w.stage === 'uploading') log(w, 'local', '上次材料传送未结束，尚未派工');
  }
  for (const d of Object.values(data.dialogs))
    for (const m of d.messages)
      if (m.pending) {
        delete m.pending;
        m.error = m.noteAction || m.reminderAction || m.memoryAction ? '上次答复没有完成，请查看操作卡片。' : '上次答复没有完成，可重新请求。';
      }
  data.toolPrefs = { ...DEFAULT_TOOL_PREFS, ...data.toolPrefs };
  data.lifeToolPrefs = { ...DEFAULT_TOOL_PREFS, ...data.lifeToolPrefs };
  const lifeHome = homeId(LIFE);
  data.dialogs[lifeHome] ??= { id: lifeHome, kind: 'home', title: '星引总管', messages: [], input: '', used: 0 };
  data.persona = { ...DEFAULT_PERSONA, ...data.persona };
  return data;
}

export function persist(data) {
  const next = JSON.stringify(data);
  if (next === lastSaved) return;
  const problem = fallback ? host.save(next) : host.commit(next);
  if (problem) throw new Error(problem);
  lastSaved = next;
}
export const online = () => host.online();
export const copy = (value) => host.copy(value);
export const browse = (value) => host.browse(value);

export class DesktopError extends Error {
  constructor(message, revoked = false) { super(message); this.revoked = revoked; }
}
async function desktop(peer, route, body) {
  return desktopValue(await native('desktop', { id: peer, route, body }));
}

function desktopValue(out) {
  if (out.revoked) throw new DesktopError('配对已失效，请在电脑重新配对', true);
  if (out.error) throw new DesktopError(out.error);
  return out.value;
}

function mergeById(current, input) {
  const merged = new Map(current.map((x) => [x.id, x]));
  for (const row of input) merged.set(row.id, { ...merged.get(row.id), ...row });
  return [...merged.values()];
}

function dialog(data, peer, source, p, kind) {
  const key = desktopKey(peer, source.id);
  const d = data.dialogs[key] ??= {
    id: key, remote: source.id, kind, project: desktopKey(peer, p.id), peer, messages: [], input: '', used: 0,
  };
  Object.assign(d, { title: source.title, session: source.session ?? d.session, listed: true, listedAt: source.at ?? d.listedAt });
}

export function addMessage(d, role, text, extra = {}) {
  const m = { id: uid(), role, text, at: now(), ...extra };
  d.messages.push(m);
  return m;
}

export function newDiscussion(data, title, projectKey, from, mode = WORK) {
  if (mode === LIFE && projectKey) throw new Error('生活对话不能挂到工作项目');
  if (from && !inMode(from, mode)) throw new Error('不能跨模式引用对话');
  const p = data.projects[projectKey];
  const remote = 'discussion:' + uid();
  const id = mode === LIFE ? 'life:' + remote : p ? desktopKey(p.peer, remote) : remote;
  const d = {
    id, remote, title, kind: 'discussion', project: projectKey, peer: p?.peer, session: from?.session,
    refer: from?.id, messages: [], input: '', used: Date.now(), own: true, listed: true, dirty: !!p,
  };
  data.dialogs[id] = d;
  return d;
}

const NEW_CHAT_TITLE = '新对话';
const TITLE_LENGTH = 24;
const titleFrom = (text) => {
  const line = String(text ?? '').split(/\r?\n/).find((part) => part.trim()) ?? '';
  const flat = line.replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(flat)) return NEW_CHAT_TITLE;
  return [...flat].slice(0, TITLE_LENGTH).join('');
};

// A quick new chat is local only until the user later attaches it to a project.
export function newChat(data, mode) {
  const d = newDiscussion(data, NEW_CHAT_TITLE, undefined, undefined, mode);
  d.autoTitle = true;
  return d;
}

// The first completed turn names an untouched new chat; the server title wins when it is usable.
export function autoTitle(d, suggested) {
  if (!d.autoTitle || d.titleEdited) return;
  const server = String(suggested ?? '').replace(/\s+/g, ' ').trim();
  if (server) {
    d.title = [...server].slice(0, 40).join('');
    delete d.autoTitle;
    return;
  }
  const first = d.messages.find((m) => m.role === 'user' && !m.kind && m.text?.trim());
  if (!first) return;
  d.title = titleFrom(first.text);
  delete d.autoTitle;
}

export function renameChat(d, title) {
  const value = String(title ?? '').trim();
  if (!value) throw new Error('标题不能为空');
  d.title = value;
  d.titleEdited = true;
  delete d.autoTitle;
}

// Attaches a phone-only chat to a shared project. Only messages sent from now on reach the desktop.
export function attachProject(data, d, projectKey) {
  if (dialogMode(d) === LIFE) throw new Error('生活对话不能挂到工作项目');
  const project = data.projects[projectKey];
  if (!project?.shared) throw new Error('这个项目还没有从电脑同步到手机');
  if (d.kind !== 'discussion') throw new Error('只有手机上的对话可以挂到项目');
  if (d.project) throw new Error('这场对话已经挂了项目');
  const prior = d.id;
  d.project = projectKey;
  d.peer = project.peer;
  d.own = true;
  d.listed = true;
  d.dirty = true;
  d.remote ||= 'discussion:' + uid();
  d.out = [];
  d.decisionOut = [];
  d.syncError = '';
  d.historyError = '';
  const next = desktopKey(project.peer, d.remote);
  if (next !== prior) {
    data.dialogs[next] = d;
    delete data.dialogs[prior];
    d.id = next;
    for (const w of Object.values(data.work ?? {})) if (w.dialog === prior) w.dialog = next;
    if (data.lastDiscussion === prior) data.lastDiscussion = next;
  }
  d.used = Date.now();
  addMessage(d, 'system', '已挂到 ' + project.name + ' · ' + (data.peers[project.peer]?.name ?? '电脑') +
    '。之后的消息会同步，之前的不会');
  return next;
}

export const listDialogs = (data, mode = WORK) => Object.values(data.dialogs)
  .filter((d) => inMode(d, mode) && (d.listed !== false || d.used || d.own));
export const decisions = (d) => d.decisions ?? [];
export const chosen = (d) => [...decisions(d)].reverse().find((x) => x.heads.length === 1);
export const transcript = (d) => {
  const remote = d.history?.messages ?? [];
  if (!remote.length) return d.messages;
  const merged = [...remote, ...d.messages];
  return d.kind === 'discussion' ? merged.sort((a, b) => a.at.localeCompare(b.at)) : merged;
};

export function recordDecision(d, text, quote, existing, parents = existing?.heads ?? []) {
  const id = existing?.id ?? uid(), version = uid();
  const input = { id, version, parents, text, quote: quote.slice(0, 3000) };
  const record = { id, heads: [...(existing?.heads ?? []).filter((x) => !parents.includes(x)), version],
    versions: [...(existing?.versions ?? []), { ...input, origin: '手机', at: now() }] };
  d.decisions = mergeById(decisions(d), [record]);
  if (d.peer && d.kind === 'discussion') (d.decisionOut ??= []).push(input);
  return record;
}

const deliveriesByPeer = new Map();
const resumeByProject = new Map();
export function projectResume(data, key) {
  const project = data.projects[key], saved = resumeByProject.get(key);
  return project?.shared && saved?.version === project.version ? saved : undefined;
}

export async function refreshProjectResume(data, key, current) {
  const project = data.projects[key];
  if (!project?.shared) throw new Error('这个项目已不再共享');
  const peer = data.peers[project.peer];
  if (!peer?.online) return;
  if (!peer.projectResume) throw new Error('桌面版尚不支持项目接续，请更新桌面端');
  const valid = () => current() && data.projects[key]?.shared && data.projects[key]?.version === project.version;
  let result;
  try { result = await desktop(project.peer, 'resume', { projectId: project.id, version: project.version }); }
  catch (error) {
    if (valid() && error.revoked) { forgetSharedProjects(data, project.peer); persist(data); }
    throw error;
  }
  if (!valid()) return;
  if (result?.allowed === false) {
    resumeByProject.delete(key); data.projects[key].shared = false;
    if (data.agentTrees) delete data.agentTrees[key];
    persist(data);
    throw new Error('电脑已撤回这个项目的共享');
  }
  if (result?.stale === true) {
    resumeByProject.delete(key);
    throw new Error('项目授权版本已变化，请刷新项目');
  }
  if (result?.allowed !== true || result.projectId !== project.id || result.version !== project.version || !Number.isFinite(Date.parse(result.at)))
    throw new Error('电脑返回了不匹配的项目接续');
  const rows = Object.fromEntries(['decisions', 'changes', 'pending', 'gaps'].map(group => {
    const items = result[group];
    if (!Array.isArray(items) || items.length > 6 || items.some(r => !r || typeof r.id !== 'string' || typeof r.text !== 'string' || r.text.length > 270 ||
        r.at !== undefined && !Number.isFinite(Date.parse(r.at)) ||
        r.target && (!['work', 'discussion'].includes(r.target.kind) || typeof r.target.id !== 'string')))
      throw new Error('电脑返回的项目接续条目无效');
    return [group, items];
  }));
  resumeByProject.set(key, { ...rows, version: result.version, at: result.at });
}

export function sharedDeliveries(data) {
  return [...deliveriesByPeer].flatMap(([peer, rows]) => data.peers[peer]?.online
    ? rows.filter(row => data.projects[desktopKey(peer, row.projectId)]?.shared).map(row => ({ ...row, peer })) : []);
}

export async function readDelivery(data, peer, id, artifact) {
  const available = () => sharedDeliveries(data).some(item => item.peer === peer && item.id === id);
  if (!available()) throw new Error('成果不再可用，连接电脑后刷新');
  const value = await desktop(peer, 'delivery', { id, ...(artifact ? { artifact } : {}) });
  if (!available()) throw new Error('成果已不在共享范围');
  return value;
}

function catalog(data, peer, value) {
  deliveriesByPeer.set(peer, value.deliveries ?? []);
  data.peers[peer].projectResume = value.capabilities?.projectResume === true;
  const active = new Set(value.projects.map((p) => desktopKey(peer, p.id)));
  for (const [key, p] of Object.entries(data.projects)) if (p.peer === peer) {
    p.shared = active.has(key);
    if (!p.shared) {
      resumeByProject.delete(key);
      if (data.agentTrees) delete data.agentTrees[key];
    }
  }
  for (const p of value.projects) {
    const key = desktopKey(peer, p.id);
    if (data.projects[key]?.version !== p.version || !data.peers[peer].projectResume) resumeByProject.delete(key);
    data.projects[key] = { ...p, key, peer, shared: true };
  }
  const ids = new Set(value.discussions.map((a) => a.id));
  for (const d of Object.values(data.dialogs))
    if (d.peer === peer && d.kind === 'discussion' && !d.own && !ids.has(d.remote)) d.listed = false;
  for (const source of value.discussions) dialog(data, peer, source, { id: source.projectId }, 'discussion');
  if (value.groups) {
    data.peers[peer].catalogIssue = value.groups.filter((x) => x.error || x.offline)
      .map((x) => (x.backend === 'codex' ? 'Codex' : 'DSH') + '：' + (x.error ?? '原生端离线，显示缓存'));
    for (const group of value.groups) {
      if (!group.items) continue;
      const project = desktopKey(peer, group.projectId);
      if (!group.offline) for (const d of Object.values(data.dialogs))
        if (d.project === project && d.kind === group.backend) d.listed = false;
      for (const source of group.items) dialog(data, peer, { ...source, at: group.at }, { id: group.projectId }, group.backend);
    }
  }
}

function forgetSharedProjects(data, peer) {
  deliveriesByPeer.delete(peer);
  for (const [key, p] of Object.entries(data.projects)) if (p.peer === peer) {
    p.shared = false;
    resumeByProject.delete(key);
    if (data.agentTrees) delete data.agentTrees[key];
  }
}

export async function refreshAgentTree(data, key) {
  const project = data.projects[key];
  if (!project?.shared || !data.peers[project.peer]?.online) throw new Error('电脑未连接');
  let result;
  try { result = await desktop(project.peer, 'agents', { projectId: project.id }); }
  catch (e) {
    if (e.revoked) { forgetSharedProjects(data, project.peer); persist(data); }
    throw e;
  }
  if (result?.allowed === false) {
    data.projects[key].shared = false;
    if (data.agentTrees) delete data.agentTrees[key];
    persist(data);
    throw new Error('电脑已撤回这个项目的共享');
  }
  if (!data.projects[key]?.shared || data.projects[key].version !== project.version)
    throw new Error('项目共享已变化，请重新打开');
  if (result?.allowed !== true || result.projectId !== project.id || !Array.isArray(result.nodes) || result.nodes.length > 250 ||
      !Number.isFinite(Date.parse(result.at))) throw new Error('电脑返回的结构无效');
  const ids = new Set();
  const nodes = result.nodes.map((n) => {
    if (typeof n.id !== 'string' || !n.id || ids.has(n.id) || typeof n.title !== 'string' ||
        !['discussion', 'executor'].includes(n.kind)) throw new Error('电脑返回的节点无效');
    ids.add(n.id);
    const s = n.session;
    const session = s && typeof s.threadId === 'string' && s.threadId &&
      (s.backend === 'codex' && !s.source || s.backend === 'dsh' && typeof s.source === 'string' && s.source)
      ? { backend: s.backend, threadId: s.threadId, source: s.source } : undefined;
    const member = n.roster;
    const roster = member && typeof member.id === 'string' && typeof member.name === 'string' &&
      ['codex', 'dsh', 'manual'].includes(member.source)
      ? { id: member.id, name: member.name, source: member.source, recorded: member.recorded === true } : undefined;
    return { id: n.id, title: n.title, parentId: n.parentId, kind: n.kind, state: n.state, at: n.at,
      backend: n.backend, model: n.model, session, discussionId: n.discussionId, workId: n.workId, roster };
  });
  (data.agentTrees ??= {})[key] = { at: result.at, truncated: result.truncated === true, nodes };
  persist(data);
}

export function agentDialog(data, key, node, nativeSession = false) {
  const project = data.projects[key];
  if (!project?.shared) throw new Error('这个项目已不再共享');
  const { peer } = project;
  if (!nativeSession) {
    if (!node.discussionId) return undefined;
    const id = desktopKey(peer, node.discussionId);
    if (!data.dialogs[id]) dialog(data, peer, { id: node.discussionId, title: node.title, session: node.session, at: node.at }, project, 'discussion');
    return data.dialogs[id];
  }
  if (!node.session) return undefined;
  const match = Object.values(data.dialogs).find((d) => d.project === key && d.kind === node.session.backend &&
    d.session?.threadId === node.session.threadId && d.session?.source === node.session.source);
  if (match) { match.listed = true; return match; }
  const ref = 'agent-session:' + node.id;
  dialog(data, peer, { id: ref, title: node.title, session: node.session, at: node.at }, project, node.session.backend);
  return data.dialogs[desktopKey(peer, ref)];
}

const nativeRef = (d) => d.kind === 'codex' || d.kind === 'dsh';

export async function refreshDialog(data, d) {
  const project = data.projects[d.project];
  if (!project?.shared || !data.peers[d.peer]?.online) return;
  if (d.own && d.dirty) await flushDialog(data, d);
  for (let pages = 0; pages < 4; pages++) {
    const prior = d.history;
    const value = await desktop(d.peer, 'history', {
      projectId: project.id, ...(nativeRef(d) ? { session: d.session }
        : { discussion: d.remote, after: prior?.cursor ?? 0, epoch: prior?.epoch }),
    });
    const local = new Set(d.messages.map((m) => m.id));
    const incoming = value.messages.filter((m) => !local.has(m.id));
    const messages = nativeRef(d) ? incoming : mergeById(prior?.messages ?? [], incoming);
    d.history = {
      at: incoming.length || !prior?.at ? value.at : prior.at, gap: value.gap || !!prior?.gap,
      cursor: value.cursor, epoch: value.epoch, offline: value.offline, reason: value.reason, messages,
    };
    if (value.decisions) d.decisions = mergeById(decisions(d), value.decisions.filter((x) => !d.decisionOut?.some((y) => y.id === x.id)));
    if (!value.more) break;
  }
  d.historyError = '';
  persist(data);
}

async function flushDialog(data, d) {
  if (d.flushing) return d.flushing;
  const task = flushChanges(data, d);
  Object.defineProperty(d, 'flushing', { value: task, configurable: true });
  try { await task; }
  finally { delete d.flushing; }
}

async function flushChanges(data, d) {
  const p = data.projects[d.project];
  while (d.dirty || d.out?.length || d.decisionOut?.length) {
    const batch = (d.out ?? []).slice(0, 5);
    const updates = (d.decisionOut ?? []).slice(0, 5);
    await desktop(d.peer, 'push', {
      projectId: p.id, discussion: d.remote, title: d.title, session: d.session,
      messages: batch.map(({ id, role, text, at }) => ({ id, role, text, at }))
        .map((m) => ({ ...m, text: m.text.slice(0, 18000) })),
      decisions: updates,
    });
    d.dirty = false;
    d.out?.splice(0, batch.length);
    d.decisionOut?.splice(0, updates.length);
    d.syncError = '';
    persist(data);
  }
}

export function materialMode(file, target) {
  if (!file.size) return 'unsupported';
  if (!target) return 'unselected';
  if (/\.zip$/i.test(file.name)) return 'excerpt';
  if (/\.(txt|md|json|ts|tsx|js|jsx|html|css|py|rs|go|cs|ya?ml|toml|xml|csv|log|diff)$/i.test(file.name))
    return 'threadId' in target ? 'excerpt' : 'original';
  if (!('threadId' in target) && target.backend === 'codex' && /\.(png|jpe?g|webp|gif)$/i.test(file.name)) return 'original';
  return 'unsupported';
}

export function openWork(data, d, goal = '', project = d.project, refs = (d.wxFiles ?? []).filter((f) => f.selected).map((f) => f.ref)) {
  if (dialogMode(d) === LIFE) throw new Error('生活模式不会把内容交给电脑');
  const p = data.projects[project];
  const id = uid();
  const target = d.session ?? (p ? { backend: p.backend ?? 'dsh', mode: 'write' } : null);
  const w = { id, dialog: d.id, project, target, goal: goal.slice(0, 10000),
    acceptance: '回到这场讨论，说明做了什么、结果和核对方式。', stage: 'draft', at: now(), log: [], refs };
  data.work[id] = w;
  addMessage(d, 'system', '', { kind: 'handoff', work: id });
  return w;
}

export function log(w, stage, detail, at = now()) {
  const last = w.log.at(-1);
  if (last?.stage !== stage || last?.detail !== detail) w.log.push({ stage, detail, at });
  w.stage = stage;
}

export function authorize(data, w) {
  const p = data.projects[w.project], d = data.dialogs[w.dialog];
  if (dialogMode(d) === LIFE) throw new Error('生活模式不会把内容交给电脑');
  if (!p?.shared || !w.target || !w.goal.trim() || !w.acceptance.trim()) throw new Error('请补齐目标、任务和验收条件');
  if (decisions(d).some((x) => x.heads.length > 1)) throw new Error('先选择冲突决定的版本，再交给电脑');
  if ((w.refs?.length ?? 0) > 3) throw new Error('每次交接最多选择 3 份材料');
  const materials = (w.refs ?? []).map((ref) => {
    const file = d.wxFiles?.find((f) => f.ref === ref);
    if (!file) throw new Error('已选材料已移除，请编辑交接再确认');
    const mode = materialMode(file, w.target);
    if (mode === 'unsupported') throw new Error('目标不支持「' + file.name + '」，请在编辑交接中取消勾选或选择支持的目标');
    return { ref, name: file.name, mode };
  });
  const discussion = d.kind === 'discussion' && d.project === w.project ? d.remote : undefined;
  const decision = discussion && chosen(d);
  w.peer = p.peer;
  w.materials = materials;
  w.command = {
    id: w.id, projectId: p.id, version: p.version, discussion, target: w.target, goal: w.goal.trim(),
    acceptance: w.acceptance.trim(), decision: decision ? { id: decision.id, version: decision.heads[0] } : undefined,
    expiresAt: Date.now() + 24 * 3600_000,
  };
  log(w, 'local', '已在手机保存这次授权，尚未派工');
  persist(data);
}

function applyReceipt(w, receipt, at) {
  // A retried pull can repeat the last event, never append another copy.
  log(w, receipt.stage, receipt.detail, at);
  w.receipt = receipt;
}

async function pull(data, pc) {
  for (let pages = 0; pages < 8; pages++) {
    const events = await desktop(pc.id, 'pull', { after: pc.cursor ?? 0 });
    for (const e of events) {
      if (e.seq <= (pc.cursor ?? 0)) continue;
      const w = data.work[e.id];
      if (w?.peer === pc.id) {
        applyReceipt(w, e.receipt, e.at);
        recordWorkNotice(w, e.receipt, e.seq, e.at);
      }
      pc.cursor = e.seq;
    }
    if (events.length) persist(data);
    if (events.length < 100) return;
  }
}

export async function refreshPeerCatalog(data, peer, current) {
  const pc = data.peers[peer.id] ??= { ...peer, online: false, cursor: 0 };
  let value;
  try { value = await desktop(peer.id, 'catalog', { native: false }); }
  catch (error) {
    if (current()) {
      pc.online = false; pc.issue = error.message;
      if (error.revoked) forgetSharedProjects(data, peer.id);
      persist(data);
    }
    return false;
  }
  if (!current()) return false;
  catalog(data, peer.id, value); pc.online = true; pc.issue = ''; pc.at = value.at;
  persist(data);
  return true;
}

export async function syncPeer(data, peer, { includeNative = false, open = '', publish = () => {}, canDispatch = () => true } = {}) {
  const pc = data.peers[peer.id] ??= { ...peer, online: false, cursor: 0 };
  const wasOnline = pc.online;
  try {
    const value = await desktop(peer.id, 'catalog', { native: false });
    catalog(data, peer.id, value);
    pc.online = true;
    pc.issue = '';
    if (!pc.at || Date.now() - Date.parse(pc.at) >= 60000) pc.at = value.at;
    persist(data);
    publish();
    await pull(data, pc);
    for (const d of listDialogs(data, WORK).filter((d) => d.peer === pc.id && d.kind === 'discussion' &&
        data.projects[d.project]?.shared && (d.dirty || d.out?.length || d.decisionOut?.length))) {
      if (!canDispatch()) break;
      try { await flushDialog(data, d); }
      catch (e) { d.syncError = e.message; }
    }
    for (const w of Object.values(data.work).filter((w) => w.stage === 'local' && w.peer === peer.id)) {
      if (!canDispatch()) break;
      if (w.stage !== 'local') continue;
      const p = data.projects[w.project], d = data.dialogs[w.dialog];
      const { projectId, version, expiresAt } = w.command;
      const valid = () => p.shared && p.version === version && Date.now() < expiresAt;
      if (!p || !valid()) {
        log(w, 'failed', '授权已过期或电脑的项目版本已变化，请核对后重新授权');
        continue;
      }
      if (w.command.discussion && (d.syncError || d.dirty || d.decisionOut?.length)) continue;
      if (w.materials?.length) {
        log(w, 'uploading', '正在传送本次授权的材料，尚未派工');
        persist(data);
        publish();
        const materials = w.command.materials ??= [];
        try {
          for (let slot = materials.length; slot < w.materials.length; slot++) {
            if (w.stage !== 'uploading') break;
            const { ref, mode } = w.materials[slot];
            const saved = desktopValue(await native('desktop.material', { id: peer.id, dialog: d.id, ref,
              info: { requestId: w.id, slot, projectId, version, expiresAt, mode, count: w.materials.length } }));
            if (w.stage !== 'uploading') break;
            if (saved.slot !== slot || !/^[a-f0-9]{64}$/.test(saved.version)) throw new Error('电脑的材料收据不匹配');
            materials.push(saved);
            persist(data);
          }
        } catch (e) {
          if (w.stage === 'uploading') log(w, 'upload-paused', '材料传送未完成，尚未派工：' + e.message);
          continue;
        }
        if (w.stage !== 'uploading') continue;
        if (!valid()) {
          log(w, 'failed', '授权已过期或电脑的项目版本已变化，尚未派工');
          continue;
        }
      }
      log(w, 'sending', '已开始发送，等待电脑的登记证据');
      persist(data);
      publish();
      if (!canDispatch()) { log(w, 'local', '已保留授权，离开接续页后继续等待投递'); break; }
      try {
        const receipt = await desktop(peer.id, 'command', { value: w.command });
        applyReceipt(w, receipt, now());
        persist(data);
      } catch (e) {
        log(w, e instanceof DesktopError ? 'failed' : 'verify', e instanceof DesktopError ? e.message : '可能已送达；重连只核对原请求，不会重发');
      }
    }
    await pull(data, pc);
    const d = data.dialogs[open];
    if (d?.peer === peer.id && (d.kind === 'discussion' || !d.history || !wasOnline)) {
      try { await refreshDialog(data, d); }
      catch (e) { d.historyError = e.message; }
    }
    if (includeNative) {
      try { catalog(data, peer.id, await desktop(peer.id, 'catalog', { native: true })); }
      catch (e) { pc.catalogIssue = [e.message]; }
    }
  } catch (e) {
    pc.online = false;
    pc.issue = e.message;
    if (e.revoked) forgetSharedProjects(data, pc.id);
  }
  persist(data);
  publish();
}

export async function respond(data, w, action, extra) {
  await desktop(w.peer, action, { id: w.id, ...extra });
  await pull(data, data.peers[w.peer]);
}

export async function readArtifact(data, w, artifact) {
  const evidenceHash = w.receipt.evidenceHash;
  const cache = data.artifactCache ?? [];
  const key = JSON.stringify([w.peer, w.id, artifact, evidenceHash]);
  const cached = cache.find((entry) => entry.key === key);
  if (!online() || !data.peers[w.peer].online) {
    if (!cached) throw new Error('电脑未连接，手机还没有这份产物的副本');
    return { ...cached, cached: true };
  }
  let read;
  try { read = await desktop(w.peer, 'artifact', { id: w.id, artifact, evidenceHash }); }
  catch (error) {
    if (cached && !(error instanceof DesktopError)) return { ...cached, cached: true };
    throw error;
  }
  if (w.receipt.evidenceHash !== evidenceHash) throw new Error('产物版本已变化，请重新打开');
  const result = { key, name: read.name, text: read.text, at: now(), turnId: w.receipt.turnId };
  data.artifactCache = [result, ...(data.artifactCache ?? []).filter((entry) => entry.key !== key)].slice(0, 4);
  persist(data);
  return result;
}

const normalize = (s) => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
function mentions(value, name, min = 2) {
  const nameKey = normalize(name);
  return nameKey.length >= min && value.includes(nameKey);
}
function scope(data, query) {
  const value = normalize(query);
  const peers = new Set(Object.values(data.peers).filter((p) => mentions(value, p.name)).map((p) => p.id));
  const named = Object.values(data.projects).filter((p) => mentions(value, p.name));
  const projects = new Set(named.map((p) => p.key));
  return { value, named: projects.size > 0, accepts: (x) => (!peers.size || peers.has(x.peer)) &&
    (!projects.size || projects.has(x.project ?? x.key)) };
}

export function namedProjects(data, query) {
  const s = scope(data, query);
  return s.named ? Object.values(data.projects).filter((p) => p.shared && s.accepts(p)) : [];
}

export function locate(data, query, useRecent = true, mode = WORK) {
  const s = mode === LIFE ? { value: query, accepts: () => true } : scope(data, query);
  const yesterday = query.includes('昨天') ? new Date() : null;
  if (yesterday) yesterday.setDate(yesterday.getDate() - 1);
  const past = (d) => d.kind === 'discussion' ? Date.parse(d.listedAt) || 0 : 0;
  const date = yesterday?.toDateString();
  const candidates = listDialogs(data, mode).filter((d) => d.kind !== 'home' && s.accepts(d) &&
    (!date || [d.used, past(d)].some((at) => at && new Date(at).toDateString() === date)));
  const meaningful = (title) => title.replace(/(?:的)?(?:项目)?(?:改版|方案|讨论|会话|记录)+$/, '');
  const exact = candidates.filter((d) => mentions(s.value, d.title));
  const matched = exact.length ? exact : candidates.filter((d) => mentions(s.value, meaningful(d.title), 3));
  if (matched.length) return matched.slice(0, 3);
  if (!useRecent || !/(?:昨天|上次|刚才)(?:的?(?:那个|那场|那段|那件|那条))?(?:讨论|会话|方案|项目|事)?[吧呢]?$/.test(s.value)) return [];
  if (date) return candidates.sort((a, b) => Math.max(b.used, past(b)) - Math.max(a.used, past(a))).slice(0, 3);
  if (/(上次|刚才)/.test(query)) return candidates.filter((d) => d.used).sort((a, b) => b.used - a.used).slice(0, 1);
  return [];
}
