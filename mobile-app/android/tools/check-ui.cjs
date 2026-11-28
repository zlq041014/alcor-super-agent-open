// Browser verification of the production UI. The fake Android bridge is only installed by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createServer } = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('../../../desktop-app/node_modules/playwright');

const root = path.resolve(__dirname, '../../..');
const app = path.join(root, 'mobile-app/android/app/src/main/assets');
const prototype = path.join(root, 'mobile-app/prototype');
const designAssets = path.join(root, 'mobile-app/prototype-v2');
const evidence = path.resolve(process.argv[2] || path.join(root, '.dev/mobile-v1/ui'));
const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

async function main() {
  await fs.mkdir(evidence, { recursive: true });
  const server = createServer(async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    const file = route.startsWith('/design/') ? path.join(prototype, route.slice(8))
      : route.startsWith('/assets/') ? path.join(designAssets, route.slice(1))
      : route === '/features/pet-data.js' ? path.join(designAssets, 'assets/pet/pet-data.js')
      : path.join(app, route === '/' ? 'index.html' : route.slice(1));
    try {
      let bytes;
      try { bytes = await fs.readFile(file); }
      catch (missing) {
        if (route.startsWith('/assets/')) bytes = await fs.readFile(path.join(prototype, route.slice(1)));
        else throw missing;
      }
      res.writeHead(200, { 'Content-Type': contentType[path.extname(file)] });
      res.end(bytes);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({ channel: 'msedge' });
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
      let online = true, desktopOnline = true, drop = false;
      if (location.search.includes('long') && !sessionStorage.getItem('long-seeded')) {
        const messages = [];
        for (let i = 1; i <= 34; i++) {
          const marker = i === 1 ? 'RAW-EARLY-PADDING ONLY-IN-RAW-1 ' : i === 3 ? 'EARLY-LONG-MARKER ' : '';
          messages.push({ id: 'long-' + i, role: i % 2 ? 'user' : 'assistant',
            text: marker + '第 ' + i + ' 条记录。' + '这是一段用于触发预算压缩的长文本。'.repeat(220),
            at: new Date(Date.now() - (40 - i) * 60000).toISOString() });
        }
        sessionStorage.setItem('state', JSON.stringify({ dialogs: {
          home: { id: 'home', kind: 'home', title: '星引总管', messages: [], input: '', used: 0 },
          'discussion:long': { id: 'discussion:long', kind: 'discussion', title: '长对话压缩', messages,
            input: '', used: Date.now(), own: true, listed: true },
        }, projects: {}, peers: {}, work: {}, last: '', lastDiscussion: 'discussion:long' }));
        sessionStorage.setItem('settings', JSON.stringify({ ready: true, model: 'deepseek-flash', effort: 'high',
          endpoint: 'https://api.deepseek.com/chat/completions', officialSearch: true, search: true, peers: [],
          phoneInbox: false, dark: false }));
        sessionStorage.setItem('long-seeded', '1');
      }
      const peer = { id: 'pc', name: '工作电脑' }, other = { id: 'pc2', name: '家里电脑' };
      let settings = JSON.parse(sessionStorage.getItem('settings')) ?? { ready: false, search: false, peers: [],
        phoneInbox: true };
      const room = { id: 'discussion:shared', title: '登录页改版', projectId: 'p' };
      const cursors = Object.values(JSON.parse(sessionStorage.getItem('state') ?? '{}').peers ?? {}).map(p => p.cursor ?? 0);
      let seq = Math.max(0, ...cursors), posts = 0, copies = '', commandId, events = [], conflict, chat, brave = false;
      let noteBranches = 0;
      let summaryRequests = 0;
      const summaryFails = location.search.includes('nosummary');
      const uploads = [];
      const pushes = [];
      let noticeLink = null;
      const noticeClaims = new Map(), noticePosts = [];
      let noticeActive = [];
      const answer = (id, value) => window.alcorResult(id, 'done', value);
      const inbox = () => JSON.parse(sessionStorage.getItem('inbox') || '[]');
      const saveInbox = (items) => sessionStorage.setItem('inbox', JSON.stringify(items));
      const notes = () => JSON.parse(sessionStorage.getItem('notes') || '[]');
      const saveNotes = (items) => sessionStorage.setItem('notes', JSON.stringify(items));
      const reminders = () => JSON.parse(sessionStorage.getItem('reminders') || '[]');
      const saveReminders = (items) => sessionStorage.setItem('reminders', JSON.stringify(items));
      const memories = () => JSON.parse(sessionStorage.getItem('memories') || '[]');
      const saveMemories = (items) => sessionStorage.setItem('memories', JSON.stringify(items));
      const reminderPermissions = { notifications: false, exact: false };
      let reminderLink = null;
      const scoped = (item, mode) => (item.mode ?? 'work') === mode;
      const counts = (mode) => notes().filter((n) => scoped(n, mode)).reduce((all, note) => ({ ...all, [note.box]: (all[note.box] || 0) + 1 }),
        { inbox: 0, filed: 0, archived: 0 });
      const newNote = (text, extra = {}) => {
        const at = Date.now();
        return { id: crypto.randomUUID(), text, image: false, project: '', source: 'app', box: 'inbox',
          created: at, modified: at, ...extra };
      };
      const stamp = () => new Date().toISOString();
      const earlier = new Date(Date.now() - 86_400_000).toISOString();
      const change = (stage, detail, extra = {}) => events.push({ id: commandId, seq: ++seq, at: stamp(), receipt: { stage, detail, ...extra } });
      window.fixture = {
        network: (value) => { online = value; },
        pc: (value) => { desktopOnline = value; },
        get copies() { return copies; }, get posts() { return posts; }, get chat() { return chat; },
        get notes() { return notes(); }, get noteBranches() { return noteBranches; },
        get reminders() { return reminders(); },
        get noticePosts() { return noticePosts; },
        get noticeActive() { return noticeActive; },
        workReceipt: (id, stage, detail, extra = {}) => events.push({ id, seq: ++seq, at: stamp(), receipt: { stage, detail, ...extra } }),
        openWorkNotice: (id) => { noticeLink = id; window.alcorWorkNoticeOpened(); },
        get memories() { return memories(); },
        openReminder: (id) => { reminderLink = { id, mode: reminders().find((r) => r.id === id)?.mode ?? 'work' }; window.alcorReminderOpened(); },
        get summaryRequests() { return summaryRequests; }, get summaryFails() { return summaryFails; },
        uploads, pauseUpload: false, get pushes() { return pushes; },
        exports: [],
        receive: (id, name) => {
          saveInbox([...inbox(), { id, mode: settings.mode ?? 'work', dialog: '', files: [{ ref: id + ':0', name, mime: 'text/plain', size: 12, source: 'phone' }] }]);
          window.alcorInbox();
        },
        lost: () => { drop = true; },
        change,
        conflict: () => {
          const id = crypto.randomUUID(), phone = crypto.randomUUID(), desktop = crypto.randomUUID();
          conflict = { id, heads: [phone, desktop], versions: [
            { id, version: phone, parents: [], text: '继续', quote: '就用继续', origin: '手机', at: stamp() },
            { id, version: desktop, parents: [], text: '下一步', quote: '改为下一步', origin: '电脑', at: stamp() },
          ] };
        },
      };
      window.AlcorNative = {
        state: () => location.search.includes('fallback')
          ? '~聊天记录迁移失败，先继续使用旧记录'
          : sessionStorage.getItem('state') ?? '',
        commit: (value) => { sessionStorage.setItem('state', value); return ''; },
        read: () => sessionStorage.getItem('legacy') ?? '',
        save: (value) => { sessionStorage.setItem('legacy', value); return ''; },
        online: () => online,
        copy: (text) => { copies = text; },
        browse: (url) => { window.openedSource = url; },
        request: (id, action, json) => {
          const body = JSON.parse(json);
          setTimeout(() => {
            if (action === 'settings') return answer(id, settings);
            if (action === 'workNotice.status') return answer(id, true);
            if (action === 'workNotice.opened') {
              const idToOpen = noticeLink; noticeLink = null; return answer(id, idToOpen);
            }
            if (action === 'workNotice.reconcile') {
              const ids = body.enabled ? body.items.map((item) => item.id) : [];
              noticeActive = noticeActive.filter((item) => ids.includes(item.id));
              for (const item of body.items) {
                if ((noticeClaims.get(item.id) ?? 0) >= item.seq) continue;
                noticeClaims.set(item.id, item.seq);
                if (body.enabled) {
                  noticePosts.push(item);
                  noticeActive = [...noticeActive.filter((n) => n.id !== item.id), item];
                }
              }
              return answer(id, body.items.length);
            }
            if (action === 'privacy.status') return answer(id, { enabled: !!fixture.lockEnabled, available: true });
            if (action === 'privacy.lock.set') {
              if (fixture.lockCancel) return window.alcorResult(id, 'error', '未通过系统验证');
              fixture.lockEnabled = body.enabled;
              return answer(id, { enabled: fixture.lockEnabled, available: true });
            }
            if (action === 'privacy.lock.now') { fixture.lockNow = true; return answer(id, true); }
            if (action === 'privacy.backup.notice') return answer(id, null);
            if (action === 'privacy.backup.export') return answer(id, { dialogs: 4 });
            if (action === 'privacy.backup.preview') return answer(id, { dialogs: 4, notes: 6, memories: 3, reminders: 2, files: 1 });
            if (action === 'privacy.backup.restore') { fixture.backupRestores = (fixture.backupRestores ?? 0) + 1; return answer(id, { dialogs: 1 }); }
            if (action === 'privacy.backup.dismiss') return answer(id, true);
            if (action === 'mode.set') {
              settings.mode = body.mode;
              sessionStorage.setItem('settings', JSON.stringify(settings));
              return answer(id, true);
            }
            if (action === 'inbox.pending') return answer(id, inbox().filter((r) => scoped(r, body.mode)));
            if (action.startsWith('memories.')) {
              const all = memories(), active = all.filter((m) => m.mode === body.mode && !m.deleted);
              if (action === 'memories.list') return answer(id, active.filter((m) => m.project === body.project).slice(body.offset, body.offset + 40));
              if (action === 'memories.context') return answer(id, active.filter((m) => m.kind === 'explicit' && m.enabled &&
                (!m.project || m.project === body.project) && (!body.query || m.text.includes(body.query))).slice(0, 6));
              if (action === 'memories.used') return answer(id, active.filter((m) => body.ids.includes(m.id)));
              if (action === 'memories.add') {
                const item = { ...body, created: Date.now(), enabled: body.kind === 'explicit' };
                saveMemories([...all, item]);
                return answer(id, item);
              }
              const item = active.find((m) => m.id === body.id);
              if (!item) return window.alcorResult(id, 'error', '这条记忆已不存在');
              if (action === 'memories.confirm') Object.assign(item, { kind: 'explicit', enabled: true });
              if (action === 'memories.update') Object.assign(item, { text: body.text, enabled: body.enabled });
              if (action === 'memories.delete') Object.assign(item, { deleted: true, text: '', sourceRef: '' });
              saveMemories(all);
              return answer(id, action === 'memories.delete' ? true : item);
            }
            if (action === 'inbox.ack' || action === 'inbox.discard') {
              saveInbox(inbox().filter((item) => item.id !== body.id || !scoped(item, body.mode))); return answer(id, true);
            }
            if (action === 'inbox.bind') {
              const items = inbox();
              const item = items.find((r) => r.id === body.id && scoped(r, body.mode));
              item.dialog = body.dialog;
              saveInbox(items);
              return answer(id, item);
            }
            if (action === 'reminders.opened') {
              const idToOpen = reminderLink;
              reminderLink = null;
              return answer(id, idToOpen);
            }
            if (action === 'reminders.permissions') return answer(id, reminderPermissions);
            if (action === 'reminders.list') {
              const items = reminders().filter((r) => scoped(r, body.mode) && body.history === (r.state !== 'scheduled'))
                .sort((a, b) => body.history ? b.at - a.at : a.at - b.at);
              return answer(id, { items: items.slice(body.offset, body.offset + 30), more: items.length > body.offset + 30, permissions: reminderPermissions });
            }
            if (action.startsWith('reminders.')) {
              const all = reminders();
              let r = all.find((x) => x.id === body.id && scoped(x, body.mode));
              if (action === 'reminders.add' && !r) {
                r = { ...body, state: 'scheduled', version: 1 };
                all.push(r);
                saveReminders(all);
              }
              if (!r) return window.alcorResult(id, 'error', '这条提醒已不存在');
              if (action === 'reminders.edit' || action === 'reminders.cancel') {
                if (r.state !== 'scheduled' || r.version !== body.version)
                  return window.alcorResult(id, 'error', '这条提醒已变化，请重新打开');
                if (action === 'reminders.edit') Object.assign(r, { text: body.text, at: body.at });
                else r.state = 'cancelled';
                r.version++;
                saveReminders(all);
              }
              return answer(id, { ...r, permissions: reminderPermissions });
            }
            if (action === 'notes.list') {
              const all = notes().filter((note) => scoped(note, body.mode) && (!body.box || note.box === body.box))
                .filter((note) => !body.query || note.text.includes(body.query));
              return answer(id, { notes: all.slice(body.offset || 0, (body.offset || 0) + 30),
                more: all.length > (body.offset || 0) + 30, counts: counts(body.mode) });
            }
            if (action === 'notes.get') {
              const note = notes().find((x) => x.id === body.id && scoped(x, body.mode));
              return note ? answer(id, note) : window.alcorResult(id, 'error', '这条笔记已不存在');
            }
            if (action === 'notes.add') {
              const existing = notes().find((x) => x.id === body.id);
              if (existing) return answer(id, existing);
              const note = newNote(body.text, { ...(body.id ? { id: body.id } : {}), source: body.source || 'app', mode: body.mode });
              saveNotes([note, ...notes()]);
              return answer(id, note);
            }
            if (action === 'notes.undoAdd') {
              const note = notes().find((x) => x.id === body.id);
              if (note && (note.source !== 'assistant' || note.created !== note.modified))
                return window.alcorResult(id, 'error', '这条笔记已改动，请到笔记里管理');
              saveNotes(notes().filter((x) => x.id !== body.id));
              return answer(id, true);
            }
            if (action === 'notes.update') {
              const all = notes(), note = all.find((x) => x.id === body.id);
              Object.assign(note, { text: body.text ?? note.text, project: body.project ?? note.project,
                box: body.box ?? note.box, modified: Date.now() });
              saveNotes(all);
              return answer(id, note);
            }
            if (action === 'notes.attach') {
              const all = notes(), note = all.find((x) => x.id === body.id);
              note.project = body.project;
              note.box = body.project ? 'filed' : 'inbox';
              note.modified = Date.now();
              saveNotes(all);
              return answer(id, note);
            }
            if (action === 'notes.box') {
              const all = notes(), note = all.find((x) => x.id === body.id);
              note.box = body.box; note.modified = Date.now();
              saveNotes(all);
              return answer(id, note);
            }
            if (action === 'notes.delete') {
              saveNotes(notes().filter((x) => x.id !== body.id));
              return answer(id, true);
            }
            if (action === 'notes.branch') {
              noteBranches++;
              return answer(id, [{ ref: 'fixture-note:0', name: '笔记原文.md', size: 12, mime: 'text/markdown', source: 'phone', selected: true }]);
            }
            if (action === 'note.preview') return answer(id, true);
            if (action === 'note.capture') {
              const note = newNote('从快速入口记下的测试笔记', { mode: body.mode });
              saveNotes([note, ...notes()]);
              answer(id, true);
              window.alcorEvent?.({ type: 'notes.changed', data: {} });
              return;
            }
            if (action === 'text.export') { window.fixture.exports.push(body); return answer(id, true); }
            if (action === 'image.export') { window.fixture.imageExport = body; return answer(id, true); }
            if (action === 'material.pick') {
              sessionStorage.setItem('inbox', JSON.stringify([{ id: 'fixture-batch', dialog: body.dialog,
                files: [{ ref: 'fixture-ref', name: '项目资料.zip', mime: 'application/zip', size: 220, source: 'phone' }] }]));
              answer(id, true); window.alcorInbox(); return;
            }
            if (action === 'pair.scan') {
              fixture.scanAttempts = (fixture.scanAttempts ?? 0) + 1;
              if (fixture.scanDenied) return window.alcorResult(id, 'error', '没有相机权限，可以粘贴配对码');
              if (fixture.scanDeferred) {
                fixture.finishScan = () => answer(id, 'ALCOR1.synthetic-example');
                return;
              }
              return answer(id, fixture.scanResult ?? null);
            }
            if (action === 'model.save' || action === 'search.save' || action === 'pair') {
              if (action === 'model.save') {
                const officialSearch = new URL(body.endpoint).hostname === 'api.deepseek.com';
                settings = { ...settings, ready: true, model: body.model, effort: body.effort, endpoint: body.endpoint, officialSearch, search: officialSearch || brave };
              }
              if (action === 'search.save') {
                brave = !!body.key;
                settings = { ...settings, search: settings.officialSearch || brave };
              }
              if (action === 'pair') {
                fixture.pairAttempts = (fixture.pairAttempts ?? 0) + 1;
                if (fixture.rejectPair) return window.alcorResult(id, 'error', '配对码已过期');
                settings = { ...settings, peers: [peer, other] };
              }
              sessionStorage.setItem('settings', JSON.stringify(settings));
              return answer(id, settings);
            }
            if (action === 'chat.begin') return answer(id, { id: 'fixture-attachment-turn', model: settings.model, officialSearch: settings.officialSearch });
            if (action === 'chat.check' || action === 'chat.end') return answer(id, true);
            if (action === 'chat') {
              chat = body.messages;
              window.fixture.chatFiles = body.files;
              window.fixture.chatTitleRequested = body.title;
              window.fixture.lastTools = body.tools;
              window.fixture.lastReminder = body.messages.find((m) => m.role === 'latest_reminder')?.content ?? '';
              const promptText = JSON.stringify(body.messages);
              const lastUser = String([...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
              const toolResult = [...body.messages].reverse().find((m) => m.role === 'tool')?.content;
              const usage = { prompt_tokens: 1234, prompt_cache_hit_tokens: 1000, prompt_cache_miss_tokens: 234,
                completion_tokens: 56, total_tokens: 1290, completion_tokens_details: { reasoning_tokens: 12 } };
              if (lastUser.includes('查汇率后总结要点')) {
                (window.fixture.attachmentPackets ??= []).push({ turn: body.turn, files: body.files, toolResult });
                if (!toolResult) return answer(id, { usage, tool_calls: [
                  { id: 'allowed', type: 'function', function: { name: 'web_search', arguments: '{"query":"汇率"}' } },
                  { id: 'blocked', type: 'function', function: { name: 'web_search', arguments: '{"query":"附件私有词"}' } },
                ] });
                window.fixture.attachmentToolResults = body.messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content));
                window.alcorResult(id, 'delta', '已核对附件与工具结果。');
                return answer(id, { usage });
              }
              if (lastUser.includes('图表渲染样本')) {
                const block = (text) => '\x60\x60\x60mermaid\n' + text + '\n\x60\x60\x60';
                const samples = lastUser.includes('错误') ? ['flowchart LR\nA -->', '%%{init: {}}%%\nflowchart LR\nA --> B'] : [
                  'flowchart LR\nA[手机] --> B[Hub] --> C[执行端] --> D[产物]\nA --> E[中继] --> B\nA --- F[本地库]',
                  'sequenceDiagram\nparticipant Phone\nparticipant Hub\nPhone->>Hub: request',
                  'classDiagram\nclass Phone\nclass Hub\nPhone --> Hub',
                  'stateDiagram-v2\n[*] --> Pending\nPending --> Complete',
                ];
                window.alcorResult(id, 'delta', samples.map(block).join('\n\n'));
                return answer(id, { usage });
              }
              if (lastUser.includes('翻页导出样本')) {
                const deck = lastUser.includes('格式错误') ? '{"title":1,"slides":[]}' : JSON.stringify({ title: '路由汇报',
                  slides: [{ title: '现状', points: ['手机连接电脑'], notes: '说明范围' },
                    { title: '确认', points: ['只显示已收到的回执', '<原样标记>'] }, { title: '收尾', points: [] }] });
                window.alcorResult(id, 'delta', '\x60\x60\x60alcor-slides\n' + deck + '\n\x60\x60\x60');
                return answer(id, { usage });
              }
              if (lastUser.includes('小引聊天样本')) {
                fixture.petStart = () => window.alcorResult(id, 'delta', '流式样本。');
                fixture.petFinish = () => answer(id, { usage });
                return;
              }
              if (lastUser.includes('候选验证')) {
                if (!toolResult) {
                  const calls = [{ id: 'memo', type: 'function', function: { name: 'memory_save',
                    arguments: JSON.stringify({ text: '长期偏好·蓝色', quote: '我长期偏好蓝色' }) } }];
                  if (lastUser.includes('网页')) calls.push({ id: 'memo-web', type: 'function', function: {
                    name: 'web_search', arguments: '{"query":"只读夹具"}',
                  } });
                  return answer(id, { usage, reasoning: '夹具', tool_calls: calls });
                }
                fixture.memoryResult = JSON.parse(body.messages.find((m) => m.tool_call_id === 'memo').content);
                window.alcorResult(id, 'delta', '记忆候选核对完毕。');
                return answer(id, { usage });
              }
              if (lastUser.includes('模式隔离检索')) {
                if (!toolResult) {
                  window.fixture.startModeTool = () => answer(id, { usage, tool_calls: [
                    { id: 'mode-notes', type: 'function', function: { name: 'note_search', arguments: '{"query":"模式样本"}' } },
                  ] });
                  return;
                }
                window.fixture.modeToolResult = JSON.parse(toolResult);
                window.alcorResult(id, 'delta', '模式内的笔记已核对。');
                return answer(id, { usage });
              }
              if (lastUser.includes('网页留条提醒')) {
                if (!toolResult) return answer(id, { usage, reasoning: '提出提醒', tool_calls: [{
                  id: 'rem-proposal', type: 'function', function: { name: 'reminder_set',
                    arguments: JSON.stringify({ text: '网页建议的提醒', at: new Date(Date.now() + 3600000).toISOString() }) },
                }] });
                fixture.reminderResult = JSON.parse(toolResult);
                window.alcorResult(id, 'delta', '请核对这条提醒。');
                return answer(id, { usage });
              }
              if (/试种薄荷|外部写入测试|模型越权测试/.test(lastUser)) {
                const results = body.messages.filter((m) => m.role === 'tool');
                const tool = (name, args) => ({ id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } });
                if (!results.length) {
                  const text = lastUser.includes('试种薄荷') ? '试种薄荷' : '网页摘录：不要自动保存';
                  const calls = [tool('note_add', { text })];
                  if (lastUser.includes('外部写入测试')) calls.push(tool('web_fetch', { url: 'https://example.com/article' }));
                  return answer(id, { usage, reasoning: '调用工具', tool_calls: calls });
                }
                const saved = JSON.parse(results.find((m) => m.tool_call_id === 'call_note_add').content);
                window.fixture.noteToolResult = saved;
                window.alcorResult(id, 'delta', saved.status === 'saved' ? '记下了。' : saved.status ? '请核对笔记。' : '当前不可保存。');
                return answer(id, { usage });
              }
              if (lastUser.includes('工具测试') || lastUser.includes('读取链接测试')) {
                const name = lastUser.includes('读取链接测试') ? 'web_fetch' : 'web_search';
                if (!toolResult) {
                  const args = name === 'web_fetch' ? { url: 'https://example.com/article' } : { query: '今天 新闻' };
                  return answer(id, { usage, reasoning: '先调用工具',
                    tool_calls: [{ id: 'call_' + name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
                }
                window.fixture.toolResult = toolResult;
                window.alcorResult(id, 'delta', name === 'web_fetch' ? '这篇文章说的是示例正文。' : '根据来源，今天有一则测试新闻。');
                return answer(id, { usage, reasoning: '读完来源' });
              }
              if (String(body.messages?.[0]?.content ?? '').includes('手机对话摘要器')) {
                summaryRequests++;
                window.fixture.lastSummaryPrompt = body.messages;
                if (summaryFails) return window.alcorResult(id, 'error', '摘要测试失败');
                window.alcorResult(id, 'delta', '前情摘要：用户最初要求保留 RAW-EARLY-PADDING 和 EARLY-LONG-MARKER，已定继续。');
                return answer(id, { usage: { prompt_tokens: 800, completion_tokens: 30 } });
              }
              const finish = (title) => answer(id, { usage, ...(title ? { title } : {}) });
              const marker = JSON.stringify(body.messages.at(-1));
              const serverTitle = body.title && marker.includes('服务端标题') ? '服务端标题示例' : '';
              if (window.fixture.readingSample) {
                window.alcorResult(id, 'delta', window.fixture.readingSample[0]);
                window.fixture.finishSample = () => {
                  window.alcorResult(id, 'delta', window.fixture.readingSample[1]);
                  finish(serverTitle);
                };
                return;
              }
              if (body.messages[0].content.includes('候选文案')) {
                window.alcorResult(id, 'delta', '- 「继续」：保留行动感\n- 「下一步」：强调流程');
                return finish(serverTitle);
              }
              if (promptText.includes('EARLY-LONG-MARKER')) {
                window.alcorResult(id, 'delta', '记得 EARLY-LONG-MARKER。');
                return finish(serverTitle);
              }
              window.alcorResult(id, 'delta', '保留简洁的按钮文案。');
              return setTimeout(() => { window.alcorResult(id, 'delta', '建议用「继续」。'); finish(serverTitle); }, 80);
            }
            if (action === 'search') return answer(id, {
              provider: settings.officialSearch ? 'DeepSeek 官方' : 'Brave Search',
              items: [{ title: '按钮的可访问名称', url: 'https://www.w3.org/WAI/ARIA/apg/patterns/button/', domain: 'www.w3.org', summary: '可访问名称。' }],
            });
            if (action === 'fetch') {
              if (!String(body.url).startsWith('https://example.com/')) return window.alcorResult(id, 'error', '网页打不开');
              return answer(id, { title: '示例文章', content: '# 示例文章\n\n这是只有网页里才有的示例正文。' });
            }
            if (action === 'desktop.material') {
              uploads.push(body);
              if (window.fixture.pauseUpload) return window.alcorResult(id, 'error', '测试传送中断');
              return answer(id, { value: { slot: body.info.slot, version: 'a'.repeat(64) } });
            }
            if (action === 'desktop') {
              if (!desktopOnline) return window.alcorResult(id, 'error', '测试电脑离线');
              const payload = body.body;
              const value = (x) => answer(id, { deviceId: body.id, value: x });
              if (body.route === 'catalog') return value({
                capabilities: { projectResume: true },
                at: stamp(), projects: fixture.revokeProject ? [] : [{ id: 'p', name: 'alcor-web', version: 'v1', backend: 'dsh' }],
                discussions: fixture.revokeProject ? [] : [{ ...room, at: body.id === peer.id ? earlier : stamp(), session: body.id === peer.id ? { backend: 'codex', threadId: 'ori' } : undefined }],
                groups: payload.native ? [{ projectId: 'p', backend: 'codex', at: stamp(),
                  items: [{ id: 'native', title: '原会话登录页', session: { backend: 'codex', threadId: 'ori' } }] }] : undefined,
              });
              if (body.route === 'resume') {
                fixture.resumeCalls = (fixture.resumeCalls ?? 0) + 1;
                if (fixture.revokeProject) return value({ allowed: false });
                if (payload.version !== 'v1') return value({ allowed: true, stale: true });
                return value({ allowed: true, projectId: 'p', version: 'v1', at: stamp(),
                  decisions: [{ id: 'summary-fixture', text: '可回查的共享决定', target: { kind: 'discussion', id: room.id } }],
                  changes: [], pending: [], gaps: [{ id: 'gap-fixture', text: '原讨论有并列决定，等待核对。' }] });
              }
              if (body.route === 'agents') return value(fixture.revokeProject ? { allowed: false } : {
                allowed: true, projectId: 'p', at: stamp(), nodes: [
                  { id: 'agent-root', kind: 'discussion', title: '登录页负责人', discussionId: room.id, state: 'discussion',
                    backend: 'codex', model: 'fixture-model', at: stamp(), session: { backend: 'codex', threadId: 'ori' } },
                  { id: 'agent-child', kind: 'executor', parentId: 'agent-root', title: '验收节点', state: 'waiting_input', backend: 'dsh', at: stamp() },
                ],
              });
              if (body.route === 'history') return value({
                at: stamp(), gap: true, decisions: conflict && !payload.session ? [conflict] : [],
                messages: payload.session ? [{ id: 'native-message', turn: 't-origin', role: 'assistant', text: 'Codex 原会话独有上下文' }]
                  : [{ id: 'desk-message', at: earlier, role: 'assistant', text: '桌面已同步的登录页摘录', origin: '电脑' }],
              });
              if (body.route === 'pull') return value(events.filter((e) => e.seq > payload.after));
              if (body.route === 'push') {
                pushes.push(payload);
                if (conflict && payload.decisions.length) {
                  const rev = payload.decisions.at(-1);
                  conflict.heads = [rev.version]; conflict.versions.push({ ...rev, at: stamp(), origin: '手机' });
                }
                return value(true);
              }
              if (body.route === 'command') {
                posts++;
                commandId = payload.value.id;
                window.fixture.lastCommand = payload.value;
                change('queued', '电脑已登记这项授权，等待执行回合',
                  { materialCount: payload.value.materials?.length });
                if (drop) { drop = false; desktopOnline = false; return window.alcorResult(id, 'error', '测试回执丢失'); }
                return value(events.at(-1).receipt);
              }
              if (body.route === 'accept') {
                fixture.acceptedEvidence = payload.evidenceHash;
                change('done', '已按原回合结果验收', { text: '同一回合的交付文字' });
                return value(true);
              }
              if (body.route === 'artifact') return value(payload.artifact === 'md-deliverable'
                ? { name: '交付.md', text: '## 已核对\n\n- 继续' } : { name: '按钮文案.txt', text: '继续' });
            }
            window.alcorResult(id, 'error', '未知测试操作 ' + action);
          }, 15);
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    const shot = (name) => page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
    const click = (label) => page.getByRole('button', { name: label, exact: true }).click();
    const openSessions = async (p) => {
      await p.getByRole('button', { name: '打开菜单' }).click();
      await p.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '找会话' }).click();
    };
    const send = async (value) => { await page.locator('#composer').fill(value); await page.locator('#composer').press('Enter'); };
    const openComputer = async () => {
      if (await page.getByRole('button', { name: '电脑', exact: true }).count()) return click('电脑');
      await click('打开菜单');
      await page.getByRole('dialog', { name: '星引' }).getByRole('button', { name: /^电脑/ }).click();
    };
    const sync = async () => { await openComputer(); await click('刷新'); await page.keyboard.press('Escape'); };
    await page.goto(origin);
    await page.locator('.hero .greet').waitFor();
    await shot('01-home');
    await click('待处理');
    await page.getByRole('dialog', { name: '待处理' }).getByText('没有待处理事项').waitFor();
    await click('关闭');
    await click('帮我起草周报开头');
    assert.equal(await page.locator('#composer').inputValue(), '帮我起草一段简短的周报开头');
    assert.equal(await page.evaluate(() => fixture.chat), undefined);
    await page.evaluate(() => fixture.network(false));
    await page.locator('#composer').fill('离线记一条：把登录页的按钮改成「继续」');
    await page.getByRole('button', { name: '记一笔', exact: true }).click();
    await page.getByText('记下了 · 在收件箱').waitFor();
    assert.equal(await page.locator('#composer').inputValue(), '');
    assert.equal(await page.evaluate(() => fixture.chat), undefined);
    assert.equal(await page.evaluate(() => fixture.notes.length), 1);
    await page.evaluate(() => fixture.network(true));
    assert.equal(await page.evaluate(() => fixture.chat), undefined);
    await page.getByRole('button', { name: '打开菜单' }).click();
    await page.getByRole('dialog', { name: '星引' }).waitFor();
    await shot('01-home-drawer');
    await page.getByRole('dialog', { name: '星引' }).getByRole('button', { name: /^笔记/ }).click();
    await page.getByText('离线记一条：把登录页的按钮改成「继续」').waitFor();
    await page.getByText('收件箱 1').waitFor();
    await shot('01a-notes');
    await page.locator('#note-q').fill('登录页');
    await page.getByRole('button', { name: /离线记一条/ }).waitFor();
    await page.getByRole('button', { name: /离线记一条/ }).click();
    await page.getByRole('button', { name: '编辑原文' }).waitFor();
    await page.getByText('离线记一条：把登录页的按钮改成「继续」').waitFor();
    await shot('01b-note');
    await page.getByRole('button', { name: '编辑原文' }).click();
    await page.locator('textarea[name=text]').fill('离线记一条：把登录页的按钮改成「继续」\n补充：副标题不动。');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText('副标题不动。').waitFor();
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await page.getByRole('dialog', { name: '导出成果' }).waitFor();
    await page.getByRole('button', { name: '复制导出内容' }).click();
    assert.match(await page.evaluate(() => fixture.copies), /副标题不动/);
    await page.getByRole('button', { name: '关闭' }).click();
    await page.getByRole('button', { name: '归档' }).click();
    await page.getByText('已归档，随时可以找回').waitFor();
    await page.getByRole('button', { name: '回到笔记' }).click();
    await page.getByRole('tab', { name: /已归档/ }).click();
    await page.getByRole('button', { name: /离线记一条/ }).click();
    await page.getByRole('button', { name: '取消归档' }).click();
    await page.getByText('已放回收件箱').waitFor();
    await page.getByRole('button', { name: '开对话' }).click();
    await page.getByText(/带来 1 条笔记/).waitFor();
    assert.equal(await page.evaluate(() => fixture.noteBranches), 1);
    assert.equal(await page.evaluate(() => fixture.chat), undefined);
    await page.getByRole('button', { name: /出自笔记/ }).click();
    await page.getByRole('button', { name: '回到对话' }).click();
    await page.getByRole('button', { name: /已收 1 份/ }).click();
    await page.getByRole('checkbox', { name: /笔记原文.md/ }).uncheck();
    await click('关闭');
    await page.getByRole('button', { name: '回到总管' }).click();
    await send('起草一句按钮文案');
    await page.getByRole('dialog', { name: '接入 DeepSeek' }).waitFor();
    await shot('02-setup');
    await page.locator('input[name=key]').fill('fixture-key');
    await click('保存并开始');
    await page.getByText('保留简洁的按钮文案。建议用「继续」。').waitFor();
    const usageText = await page.locator('.usage').first().textContent();
    await page.getByLabel('用量与花费').first().click();
    assert.match(usageText, /输入 1,234/);
    assert.match(usageText, /命中 1,000 \/ 未命中 234/);
    assert.match(usageText, /输出 56/);
    assert.match(usageText, /思考 12/);
    assert.match(usageText, /≈¥0\.00/);
    assert.match(usageText, /今日 ¥0\.00/);
    await shot('02a-usage');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.chat)), /登录页的按钮改成/);
    assert.ok(await page.evaluate(async () => {
      document.activeElement?.blur();
      const bubble = document.querySelector('.msg.manager .bubble'), input = document.querySelector('#composer');
      window.alcorForeground();
      await new Promise((resolve) => queueMicrotask(resolve));
      return bubble === document.querySelector('.msg.manager .bubble') && input === document.querySelector('#composer');
    }));
    await click('复制');
    assert.match(await page.evaluate(() => fixture.copies), /继续/);
    await send('/搜索 可访问按钮');
    await page.getByText('联网搜索 · 1 个来源').waitFor();
    await page.getByText(/检索于 .* · DeepSeek 官方/).waitFor();
    assert.equal(await page.getByRole('dialog', { name: '接入联网搜索' }).count(), 0);
    await page.getByRole('link', { name: /按钮的可访问名称/ }).click();
    assert.equal(await page.evaluate(() => window.openedSource), 'https://www.w3.org/WAI/ARIA/apg/patterns/button/');
    await page.getByRole('button', { name: '复制', exact: true }).nth(1).waitFor();
    await shot('03-search');
    const custom = await context.newPage();
    await custom.goto(origin);
    await custom.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await custom.locator('input[name=key]').fill('fixture-custom-key');
    await custom.getByText('模型与网关', { exact: true }).click();
    await custom.locator('input[name=endpoint]').fill('https://gateway.example/chat/completions');
    await custom.getByRole('button', { name: '保存并开始', exact: true }).click();
    await custom.getByText('DeepSeek · 手机直连', { exact: true }).waitFor();
    await custom.locator('#composer').fill('/搜索 可访问按钮');
    await custom.locator('#composer').press('Enter');
    await custom.getByRole('dialog', { name: '接入联网搜索' }).waitFor();
    await custom.locator('input[name=key]').fill('fixture-search-key');
    await custom.getByRole('button', { name: '保存搜索配置', exact: true }).click();
    await custom.getByText(/检索于 .* · Brave Search/).waitFor();
    await custom.close();
    await page.evaluate(() => { fixture.network(false); window.alcorForeground(); });
    await page.getByText(/手机没有网络/).waitFor();
    await send('保存这条离线草稿');
    await page.getByText('草稿 · 未发送').waitFor();
    await shot('04-offline');
    await page.reload();
    await page.getByText('保存这条离线草稿').waitFor();
    await openComputer();
    await click('配对一台电脑');
    await page.locator('textarea[name=code]').fill('synthetic-paste');
    await page.evaluate(() => { fixture.scanDenied = true; });
    await click('扫一扫');
    await page.getByRole('alert').getByText('没有相机权限，可以粘贴配对码').waitFor();
    assert.equal(await page.locator('textarea[name=code]').inputValue(), 'synthetic-paste');
    await page.evaluate(() => { fixture.scanDenied = false; fixture.scanResult = 'ALCOR1.synthetic-example'; });
    await click('扫一扫');
    await page.getByRole('status').getByText('已填入配对码，点「配对」继续。').waitFor();
    assert.equal(await page.locator('textarea[name=code]').inputValue(), 'ALCOR1.synthetic-example');
    assert.equal(await page.evaluate(() => fixture.pairAttempts ?? 0), 0);
    await click('配对');
    await page.getByText('工作电脑', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await openSessions(page);
    await page.getByText('登录页改版', { exact: true }).first().waitFor();
    await shot('05-sessions');
    await page.getByRole('tab', { name: '分类', exact: true }).click();
    await page.getByText('原会话登录页', { exact: true }).first().waitFor();
    await click('回到总管');
    await send('接着聊登录页改版');
    await page.getByText('找到了几个可能的会话。你想接哪一个？').waitFor();
    await shot('06-choices');
    await send('接着聊昨天的登录页讨论，把首屏按钮改到登录页');
    await page.getByRole('heading', { name: '登录页改版' }).waitFor();
    await page.getByText('alcor-web · 工作电脑', { exact: true }).waitFor();
    await page.getByText(/确认后才会发送/).waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    await shot('06a-resume-handoff');
    await click('先不发');
    await click('回到总管');
    await page.evaluate(() => fixture.pc(false));
    await send('在家里电脑的原会话登录页里，让 Codex 改一下标题');
    await page.getByRole('heading', { name: '原会话登录页' }).waitFor();
    await page.getByText('alcor-web · 家里电脑', { exact: true }).waitFor();
    await page.getByText('尚无同步正文，只显示已保存的记录').waitFor();
    await page.evaluate(() => { fixture.pc(true); window.alcorForeground(); });
    await page.getByText('Codex 原会话独有上下文').waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    await click('先不发');
    await send('先总结现状');
    await page.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fixture.chat)), /Codex 原会话独有上下文/);
    await page.getByRole('button', { name: /本轮材料/ }).click();
    await page.getByLabel(/原生会话摘录/).check();
    await click('好');
    await send('请根据选中的材料再总结一次');
    await page.waitForFunction(() => fixture.chat.at(-1).content.includes('请根据选中的材料再总结一次'));
    assert.match(await page.evaluate(() => fixture.chat.at(-1).content), /Codex 原会话独有上下文/);
    await click('回到总管');
    await send('把标题写入 alcor-web');
    await page.getByRole('dialog', { name: '发往哪里' }).waitFor();
    assert.equal(await page.locator('select[name=project]').inputValue(), '');
    await click('关闭');
    await click('先不发');
    await send('让家里电脑的 alcor-web 执行标题核对');
    await page.getByText('新建 DSH 托管工作', { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    await click('先不发');
    await send('接着聊工作电脑的登录页改版');
    await page.getByRole('heading', { name: '登录页改版' }).waitFor();
    await page.getByText('桌面已同步的登录页摘录').waitFor();
    assert.ok(await page.evaluate(async () => {
      document.activeElement?.blur();
      const stream = document.querySelector('.stream'), input = document.querySelector('#composer');
      window.alcorForeground();
      await new Promise((resolve) => setTimeout(resolve, 140));
      return stream === document.querySelector('.stream') && input === document.querySelector('#composer');
    }));
    await send('按钮文案再短一点');
    await page.getByText('文案备选', { exact: true }).waitFor();
    await page.getByRole('button', { name: '用这个', exact: true }).first().click();
    await page.getByText('已记下决定：继续').waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    await send('把按钮文案改到登录页');
    await page.getByText('确认后才会发送', { exact: false }).waitFor();
    assert.equal(await page.locator('.kv dt').filter({ hasText: '附带决定' }).evaluate((dt) => dt.nextElementSibling.textContent), '继续');
    await shot('07-handoff');
    await click('编辑交接');
    assert.match(await page.locator('select[name=target] option:checked').textContent(), /Codex 原会话/);
    await click('保存交接草稿');
    await page.evaluate(() => fixture.pc(false));
    await click('交给电脑');
    await page.getByText('已记下，等电脑上线', { exact: true }).waitFor();
    await shot('08-local');
    await click('撤销');
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    await send('把第二份文案改到登录页');
    await page.evaluate(() => { fixture.pc(true); fixture.lost(); });
    await click('交给电脑');
    await page.getByText('送达待核对', { exact: true }).waitFor();
    await shot('09-verify');
    await page.evaluate(() => fixture.pc(true));
    await sync();
    await page.getByText('电脑已收到，等待执行', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), 1);
    await page.evaluate(() => fixture.change('running', '原会话已确认对应回合', { turnId: 'isolated-turn' }));
    await sync();
    await page.getByText('执行中', { exact: true }).waitFor();
    await page.evaluate(() => fixture.change('review', '原会话已结束，请核对结果', {
      text: '## 同一回合的交付文字', evidenceHash: '0'.repeat(64), artifacts: [
        { id: 'text-deliverable', name: '按钮文案.txt' }, { id: 'md-deliverable', name: '交付.md' }],
    }));
    await sync();
    await page.getByRole('heading', { name: '同一回合的交付文字' }).waitFor();
    await shot('10-review');
    await page.getByRole('button', { name: /按钮文案.txt/ }).click();
    await page.getByRole('dialog', { name: '按钮文案.txt' }).waitFor();
    await shot('10a-artifact');
    await page.getByRole('button', { name: '复制正文' }).click();
    assert.equal(await page.evaluate(() => fixture.copies), '继续');
    await page.getByRole('button', { name: '回到回执' }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: /交付.md/ }).click();
    await page.getByRole('dialog').getByRole('heading', { name: '已核对' }).waitFor();
    await page.getByRole('button', { name: '复制正文' }).click();
    assert.equal(await page.evaluate(() => fixture.copies), '## 已核对\n\n- 继续');
    await click('导出产物');
    await page.getByRole('dialog', { name: '导出成果' }).waitFor();
    await shot('10b-export');
    await click('复制导出内容');
    await click('保存 .md');
    await click('系统分享');
    await page.waitForFunction(() => fixture.exports.length === 2);
    const exported = await page.evaluate(() => [fixture.copies, fixture.exports]);
    assert.deepEqual(exported[1].map((entry) => entry.mode), ['save', 'share']);
    assert.ok(exported[1].every((entry) => entry.title === '交付.md' && entry.text === exported[0]));
    assert.match(exported[0], /^## 已核对\n\n- 继续\n\n---\n\n### 出处/);
    await click('返回');
    await click('关闭');
    await page.evaluate(() => { fixture.network(false); fixture.pc(false); window.alcorForeground(); });
    await page.getByText(/手机没有网络/).waitFor();
    await page.getByRole('button', { name: /交付.md/ }).click();
    await page.getByText(/手机已存副本/).waitFor();
    await page.getByRole('dialog').getByRole('heading', { name: '已核对' }).waitFor();
    await page.evaluate(() => { fixture.network(true); fixture.pc(true); window.alcorForeground(); });
    await page.getByRole('button', { name: '关闭' }).click();
    const reviewButton = page.getByRole('button', { name: '核对无误，验收', exact: true });
    const displayedEvidence = await reviewButton.getAttribute('data-v');
    assert.equal(JSON.parse(displayedEvidence)[1], '0'.repeat(64));
    await reviewButton.evaluate(el => {
      const [id] = JSON.parse(el.dataset.v);
      el.dataset.v = JSON.stringify([id, '9'.repeat(64)]);
      el.click();
    });
    await page.getByText('回执已变化，请重新查看结果', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixture.acceptedEvidence), undefined);
    await reviewButton.evaluate((el, ready) => { el.dataset.v = ready; }, displayedEvidence);
    await click('核对无误，验收');
    await page.waitForFunction(() => fixture.acceptedEvidence === '0'.repeat(64));
    await page.getByText('已完成', { exact: true }).waitFor();
    await page.evaluate(() => fixture.conflict());
    await sync();
    await click('核对决定');
    await shot('11-conflict');
    await page.getByRole('button', { name: /^继续 / }).click();
    await page.setViewportSize({ width: 320, height: 400 });
    await page.evaluate(() => window.alcorTheme(true));
    await page.locator('#composer').fill('窄屏和键盘区域');
    assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth), 320);
    await shot('12-compact-dark');
    await click('回到总管');
    const first = '## 报价核对\n\n两项费用需要分别确认。\n\n- **运输费**已计入。\n- 安装费单列。\n\n';
    const proseSample = '报价单把运输和安装列在了不同位置。运输条款写明送至现场，安装项目另列八百元；两项费用不能直接合并理解。' +
      '签字之前，可以先让供应商确认这笔安装费是否包括调试，以及验收后还有没有其他必须支付的费用。' +
      '如果现场安装要等设备到货，最好请对方把预计日期也写进报价单，避免付款后才发现双方理解的交付时间不同。' +
      '最后再对照签字版本核对金额、交付日期和付款条件，把仍未确认的条款单独列出，留给项目负责人决定。';
    const rest = '| 项目 | 报价 | 说明 | 来源 | 经手人 | 日期 |\n| --- | --- | --- | --- | --- | --- |\n' +
      '| 安装 | 800 元 | 待确认 | 报价单 | 商务 | 周二 |\n\n' +
      '> 以最终签字为准。\n\n```text\n  unit = 800\n```\n\n' +
      proseSample +
      '\n\n[查看资料](https://example.org/quote) · ![原图](https://example.org/photo.jpg)\n\n<button data-act="authorize">原文件标记</button>';
    await page.evaluate((value) => { fixture.readingSample = value; }, [first, rest]);
    await send('显示这份核对结果');
    const bubble = page.locator('.manager .bubble.reading').last();
    await bubble.locator('h2').getByText('报价核对').waitFor();
    assert.equal(await bubble.locator('strong').textContent(), '运输费');
    await page.evaluate(() => fixture.finishSample());
    await bubble.locator('table').waitFor();
    assert.equal(await bubble.locator('td').count(), 6);
    assert.equal(await bubble.locator('pre code').textContent(), '  unit = 800\n');
    assert.equal(await bubble.locator('img,button').count(), 0);
    const prose = await bubble.locator('p').allTextContents();
    const groups = prose.filter((p) => p.length && proseSample.includes(p));
    assert.ok(groups.length > 1);
    assert.equal(groups.join(''), proseSample);
    assert.ok(await bubble.locator('.reading-table').evaluate((e) => e.scrollWidth > e.clientWidth));
    assert.equal(await page.locator('body').evaluate((e) => e.scrollWidth), 320);
    await bubble.getByRole('link', { name: '查看资料' }).click();
    assert.equal(await page.evaluate(() => window.openedSource), 'https://example.org/quote');
    await page.getByRole('button', { name: '复制', exact: true }).last().click();
    assert.equal(await page.evaluate(() => fixture.copies), first + rest);
    await page.reload();
    await page.locator('.manager .reading table').waitFor();
    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => window.alcorTheme(false));
    await bubble.evaluate((e) => e.scrollIntoView({ block: 'start' }));
    await shot('13-reading');
    await click('Flash');
    assert.equal(await page.locator('select[name=preset]').inputValue(), 'deepseek-flash');
    await page.getByLabel('思考强度').selectOption('low');
    await page.locator('select[name=preset]').selectOption('deepseek-v4-pro');
    await click('保存并开始'); await click('Pro');
    await page.getByLabel('思考强度').selectOption('high');
    await page.locator('select[name=preset]').selectOption('deepseek-flash');
    await click('保存并开始');
    await click('更多操作');
    await page.getByRole('button', { name: /本机文件/ }).click();
    const received = page.getByRole('checkbox', { name: /项目资料.zip/ });
    await received.waitFor(); assert.equal(await received.isChecked(), true);
    await shot('14-local-files');
    await page.reload(); await click('已收 1 份 · 本轮 1 份');
    await page.keyboard.press('Escape');
    await send('查汇率后总结要点');
    await page.getByText('已核对附件与工具结果。', { exact: true }).waitFor();
    const attachment = await page.evaluate(() => ({ packets: fixture.attachmentPackets, tools: fixture.attachmentToolResults }));
    assert.deepEqual(attachment.packets.map(p => [p.turn, p.files]), [
      ['fixture-attachment-turn', ['fixture-ref']], ['fixture-attachment-turn', ['fixture-ref']],
    ]);
    assert.equal(attachment.tools[0].query, '汇率');
    assert.match(attachment.tools[1].error, /本轮原话/);
    await page.getByText('本轮材料：项目资料.zip', { exact: true }).waitFor();
    await page.getByRole('button', { name: '已收 1 份 · 本轮 0 份' }).waitFor();
    const before = await page.evaluate(() => fixture.posts);
    await click('已收 1 份 · 本轮 0 份');
    await page.getByRole('checkbox', { name: /项目资料.zip/ }).check();
    await page.keyboard.press('Escape');
    await send('交给电脑核对这些材料');
    const currentDraft = page.locator('.card-box').filter({ hasText: '交给电脑核对这些材料' }).last();
    const draftButton = (name) => currentDraft.getByRole('button', { name, exact: true });
    const editor = page.getByRole('dialog', { name: '发往哪里' });
    if (!(await editor.isVisible())) await draftButton('编辑交接').click();
    await editor.locator('select[name=project]').selectOption({ label: 'alcor-web · 工作电脑' });
    await editor.locator('select[name=target]').selectOption('codex');
    const material = editor.getByRole('checkbox', { name: /项目资料.zip/ });
    assert.equal(await material.isChecked(), true);
    await material.uncheck(); await material.check();
    await click('保存交接草稿');
    await currentDraft.getByText('项目资料.zip · ZIP 文字摘录 · 不含图片').waitFor();
    await shot('15-material-handoff');
    await page.evaluate(() => { fixture.pauseUpload = true; });
    await draftButton('交给电脑').click();
    await currentDraft.getByText('材料传送暂停，尚未派工', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => fixture.posts), before);
    await page.evaluate(() => { fixture.pauseUpload = false; });
    await draftButton('重传材料').click();
    await currentDraft.getByText('电脑已收到 1 份材料。等待执行回合提供材料回执。').waitFor();
    const [uploads, lastCommand, posts] = await page.evaluate(() => [fixture.uploads, fixture.lastCommand, fixture.posts]);
    assert.equal(posts, before + 1);
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[0], uploads[1]);
    assert.equal(uploads[1].info.requestId, lastCommand.id);
    assert.equal(uploads[1].info.mode, 'excerpt');
    assert.deepEqual(lastCommand.materials, [{ slot: 0, version: 'a'.repeat(64) }]);
    await page.evaluate(() => fixture.change('running', '原生执行端已确认回合开始',
      { materialCount: 1, materialInputs: [{ kind: 'text', count: 1 }] }));
    await sync();
    await currentDraft.getByText('电脑已收到 1 份材料。本回合已传入正文 1 份。').waitFor();
    await shot('16-material-receipt');
    await page.evaluate(() => fixture.receive('external-1', '外部共享.txt'));
    const inboxSheet = page.getByRole('dialog', { name: '选择接收讨论' });
    await inboxSheet.getByText('外部共享.txt', { exact: true }).waitFor();
    assert.equal(await inboxSheet.getByLabel('放到').inputValue(), '');
    assert.equal(await page.evaluate(() => Object.values(JSON.parse(sessionStorage.state).dialogs)
      .some((d) => d.wxFiles?.some((f) => f.ref === 'external-1:0'))), false);
    await click('稍后归入');
    await page.reload();
    await inboxSheet.waitFor();
    await shot('17-inbox-target');
    await inboxSheet.getByLabel('放到').selectOption(':new');
    await click('归入讨论');
    const assigned = page.getByRole('dialog', { name: '收到文件' });
    await assigned.getByText('外部共享.txt', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => Object.values(JSON.parse(sessionStorage.state).dialogs)
      .find((d) => d.wxFiles?.some((f) => f.ref === 'external-1:0')).title), '文件讨论');
    await click('关闭');
    await page.evaluate(() => fixture.receive('external-2', '将丢弃.txt'));
    await inboxSheet.getByText('将丢弃.txt', { exact: true }).waitFor();
    await click('丢弃这批');
    await inboxSheet.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.inbox).length), 0);
    assert.equal(await page.evaluate(() => fixture.posts), 0);
    assert.deepEqual(errors, []);
    const fresh = await context.newPage();
    fresh.on('pageerror', (error) => errors.push(String(error)));
    const freshClick = (label) => fresh.getByRole('button', { name: label, exact: true }).click();
    const freshSend = async (value) => { await fresh.locator('#composer').fill(value); await fresh.locator('#composer').press('Enter'); };
    const freshShot = (name) => fresh.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
    await fresh.goto(origin);
    await fresh.locator('.hero .greet').waitFor();
    await freshClick('接入 DeepSeek');
    await fresh.locator('input[name=key]').fill('fixture-key');
    await freshClick('保存并开始');
    await fresh.getByText('DeepSeek · 手机直连', { exact: true }).waitFor();
    await fresh.getByRole('button', { name: '打开菜单' }).click();
    const drawer = fresh.getByRole('dialog', { name: '星引' });
    await drawer.getByRole('button', { name: '新对话', exact: true }).waitFor();
    await freshShot('18-new-chat-entry');
    await drawer.getByRole('button', { name: '新对话', exact: true }).click();
    await fresh.getByRole('heading', { name: '新对话' }).waitFor();
    assert.equal(await fresh.getByRole('dialog', { name: '开一场新讨论' }).count(), 0);
    assert.equal(await fresh.locator('#composer').inputValue(), '');
    await freshShot('19-new-chat-empty');
    await freshSend('  自动标题   验证  第一行，这是一段会被截断的很长的内容  \n第二行不应出现');
    await fresh.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    const autoTitle = await fresh.locator('.topbar h1').textContent();
    assert.equal(autoTitle, '自动标题 验证 第一行，这是一段会被截断的很长的');
    assert.equal([...autoTitle].length, 24);
    assert.doesNotMatch(autoTitle, /第二行| {2}/);
    await freshShot('20-new-chat-auto-title');
    await fresh.getByRole('button', { name: '关联与决定' }).click();
    const links = fresh.getByRole('dialog', { name: '这场讨论关联的' });
    await links.getByRole('button', { name: '改名' }).click();
    const rename = fresh.getByRole('dialog', { name: '改名' });
    await freshShot('21a-new-chat-rename');
    await rename.locator('input[name=title]').fill('   ');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await fresh.getByText('标题不能为空').waitFor();
    assert.equal(await rename.count(), 1);
    await fresh.evaluate(() => { document.querySelector('#notice').textContent = ''; document.querySelector('#notice').className = ''; });
    await rename.locator('input[name=title]').fill('我的新标题');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await fresh.getByRole('heading', { name: '我的新标题' }).waitFor();
    await freshShot('21-new-chat-renamed');
    await freshSend('改名之后再发一条');
    await fresh.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).nth(1).waitFor();
    assert.equal(await fresh.locator('.topbar h1').textContent(), '我的新标题');
    await fresh.getByRole('button', { name: '回到总管' }).click();
    await fresh.getByRole('button', { name: '打开菜单' }).click();
    await fresh.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '新对话', exact: true }).click();
    await fresh.getByRole('heading', { name: '新对话' }).waitFor();
    await freshSend('？？？！');
    await fresh.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    assert.equal(await fresh.locator('.topbar h1').textContent(), '新对话');
    await freshShot('22-new-chat-fallback');
    const saved = await fresh.evaluate(() => JSON.parse(sessionStorage.state));
    const dialogs = Object.values(saved.dialogs);
    const renamed = dialogs.find((d) => d.title === '我的新标题');
    assert.ok(renamed);
    assert.equal(renamed.project, undefined);
    assert.equal(renamed.peer, undefined);
    assert.equal(renamed.titleEdited, true);
    assert.equal(renamed.messages.filter((m) => m.role === 'assistant').length, 2);
    const fallback = dialogs.find((d) => d.id !== renamed.id && d.title === '新对话');
    assert.ok(fallback);
    assert.equal(fallback.project, undefined);
    assert.equal(fallback.autoTitle, undefined);
    assert.equal(fallback.messages.filter((m) => m.role === 'assistant').length, 1);
    assert.equal(await fresh.evaluate(() => fixture.posts), 0);
    await fresh.getByRole('button', { name: '回到总管' }).click();
    await fresh.getByRole('button', { name: '打开菜单' }).click();
    await fresh.getByRole('dialog', { name: '星引' }).getByRole('button', { name: /找会话/ }).click();
    await fresh.getByRole('heading', { name: '找会话' }).waitFor();
    await freshClick('新讨论');
    const named = fresh.getByRole('dialog', { name: '开一场新讨论' });
    assert.equal(await named.getByLabel('讨论标题').count(), 1);
    assert.equal(await named.getByLabel('项目').count(), 1);
    await fresh.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    await fresh.getByRole('button', { name: '回到总管' }).click();
    await fresh.getByRole('button', { name: '打开菜单' }).click();
    await fresh.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '新对话', exact: true }).click();
    await fresh.getByRole('heading', { name: '新对话' }).waitFor();
    await freshSend('服务端标题 测试');
    await fresh.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    await fresh.getByRole('heading', { name: '服务端标题示例' }).waitFor();
    assert.equal(await fresh.evaluate(() => fixture.chatTitleRequested), true);
    await freshShot('23-server-title');
    const attachPage = await context.newPage();
    attachPage.on('pageerror', (error) => errors.push(String(error)));
    await attachPage.goto(origin);
    await attachPage.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await attachPage.locator('input[name=key]').fill('fixture-key');
    await attachPage.getByRole('button', { name: '保存并开始', exact: true }).click();
    await attachPage.getByText('DeepSeek · 手机直连', { exact: true }).waitFor();
    await attachPage.getByRole('button', { name: '电脑' }).click();
    await attachPage.getByRole('button', { name: '配对一台电脑' }).click();
    await attachPage.locator('textarea[name=code]').fill('fixture-invite');
    await attachPage.getByRole('button', { name: '配对', exact: true }).click();
    await attachPage.getByText('工作电脑', { exact: true }).waitFor();
    await attachPage.getByRole('button', { name: '刷新' }).click();
    await attachPage.keyboard.press('Escape');
    await attachPage.getByRole('button', { name: '打开菜单' }).click();
    await attachPage.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '新对话', exact: true }).click();
    await attachPage.getByRole('heading', { name: '新对话' }).waitFor();
    await attachPage.locator('#composer').fill('挂项目之前的内容');
    await attachPage.locator('#composer').press('Enter');
    await attachPage.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    await attachPage.locator('#composer').fill('交给电脑：把标题改到登录页');
    await attachPage.locator('#composer').press('Enter');
    await attachPage.getByText('这场对话还没有挂项目。先点右上角「挂到项目」，挂上之后才能交给电脑。').waitFor();
    assert.equal(await attachPage.evaluate(() => fixture.posts), 0);
    await attachPage.getByRole('button', { name: '挂到项目' }).click();
    const attachSheet = attachPage.getByRole('dialog', { name: '挂到项目' });
    await attachSheet.getByText('之后的消息会同步到那台电脑，之前的不会。').waitFor();
    await attachSheet.getByRole('button', { name: /alcor-web 工作电脑/ }).click();
    await attachPage.getByText(/已挂到 alcor-web · 工作电脑/).waitFor();
    await attachPage.getByText('alcor-web · 工作电脑', { exact: true }).waitFor();
    await attachPage.evaluate(() => window.alcorForeground());
    await attachPage.waitForFunction(() => fixture.pushes.some((p) => (p.messages ?? []).length === 0));
    const firstPush = await attachPage.evaluate(() => fixture.pushes.find((p) => (p.messages ?? []).length === 0));
    assert.equal(firstPush.title, '挂项目之前的内容');
    await attachPage.locator('#composer').fill('挂上之后的消息');
    await attachPage.locator('#composer').press('Enter');
    await attachPage.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).last().waitFor();
    await attachPage.evaluate(() => window.alcorForeground());
    await attachPage.waitForFunction(() => fixture.pushes.some((p) => (p.messages ?? []).some((m) => m.text === '挂上之后的消息')));
    const pushes = await attachPage.evaluate(() => fixture.pushes);
    assert.ok(pushes.every((p) => !JSON.stringify(p.messages ?? []).includes('挂项目之前的内容')));
    assert.ok(pushes.every((p) => !JSON.stringify(p.messages ?? []).includes('把标题改到登录页')));
    await attachPage.getByRole('button', { name: '关联与决定' }).click();
    await attachPage.getByRole('dialog', { name: '这场讨论关联的' }).getByRole('button', { name: '交给电脑', exact: true }).waitFor();
    await attachPage.keyboard.press('Escape');
    await attachPage.screenshot({ path: path.join(evidence, '24-attach-project.png'), animations: 'disabled' });
    await attachPage.close();
    const toolPage = await context.newPage();
    toolPage.on('pageerror', (error) => errors.push(String(error)));
    await toolPage.goto(origin);
    await toolPage.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await toolPage.locator('input[name=key]').fill('fixture-key');
    await toolPage.getByRole('button', { name: '保存并开始', exact: true }).click();
    await toolPage.getByText('DeepSeek · 手机直连', { exact: true }).waitFor();
    const toolSend = async (value) => { await toolPage.locator('#composer').fill(value); await toolPage.locator('#composer').press('Enter'); };
    await toolSend('记一下：试种薄荷');
    await toolPage.getByText('记进收件箱：试种薄荷').waitFor();
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 1);
    await toolPage.reload();
    await toolPage.getByRole('button', { name: '撤销', exact: true }).click();
    await toolPage.getByText('已撤销', { exact: true }).waitFor();
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 0);
    await toolSend('外部写入测试');
    await toolPage.getByText('确认记入笔记？').waitFor();
    await toolPage.getByText('请核对笔记。', { exact: true }).waitFor();
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 0);
    assert.deepEqual(await toolPage.evaluate(() => fixture.noteToolResult), { status: 'needs_confirmation' });
    await toolPage.screenshot({ path: path.join(evidence, '26a-note-confirm.png'), animations: 'disabled' });
    await toolPage.getByRole('button', { name: '记入笔记', exact: true }).click();
    await toolPage.getByText('记进收件箱：网页摘录：不要自动保存').waitFor();
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 1);
    await toolPage.getByRole('button', { name: '撤销', exact: true }).click();
    await toolPage.locator('.note-action-receipt').last().getByText('已撤销').waitFor();
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 0);
    await toolPage.locator('#composer').fill('工具测试：今天有什么新闻？');
    await toolPage.locator('#composer').press('Enter');
    await toolPage.getByText('根据来源，今天有一则测试新闻。', { exact: true }).waitFor({ timeout: 60000 });
    const toolNames = await toolPage.evaluate(() => fixture.lastTools.map((tool) => tool.function.name));
    assert.deepEqual(toolNames, ['memory_search', 'memory_save', 'web_search', 'web_fetch', 'note_search', 'note_add', 'reminder_set', 'reminder_list', 'reminder_cancel']);
    assert.match(await toolPage.evaluate(() => fixture.lastReminder), /^\d{4}-\d{2}-\d{2},星期[一二三四五六日],,App,中文$/);
    assert.match(await toolPage.evaluate(() => fixture.toolResult), /按钮的可访问名称/);
    const toolRun = toolPage.locator('.tool-run').last();
    await toolRun.locator('summary').getByText('联网搜索 ×1').waitFor();
    await toolRun.locator('summary').click();
    await toolRun.getByText('联网搜索', { exact: true }).waitFor();
    await toolPage.locator('.src-item').filter({ hasText: '按钮的可访问名称' }).waitFor();
    assert.match(await toolPage.locator('.usage').last().textContent(), /工具 ≈¥0\.0050/);
    await toolPage.screenshot({ path: path.join(evidence, '27-tools.png'), animations: 'disabled' });
    await toolPage.locator('#composer').fill('读取链接测试');
    await toolPage.locator('#composer').press('Enter');
    await toolPage.getByText('这篇文章说的是示例正文。', { exact: true }).waitFor({ timeout: 60000 });
    assert.match(await toolPage.evaluate(() => fixture.toolResult), /只有网页里才有的示例正文/);
    await toolPage.getByRole('button', { name: '打开菜单' }).click();
    await toolPage.getByRole('dialog', { name: '星引' }).getByRole('button', { name: /助手能力/ }).click();
    const permissions = toolPage.getByRole('dialog', { name: '助手能力' });
    await permissions.locator('.toggle-row').filter({ hasText: '联网搜索' }).waitFor();
    await permissions.getByRole('checkbox').first().uncheck();
    await permissions.getByRole('checkbox', { name: '助手记一笔' }).uncheck();
    await toolPage.screenshot({ path: path.join(evidence, '28-permissions.png'), animations: 'disabled' });
    await toolPage.keyboard.press('Escape');
    await toolPage.locator('#composer').fill('普通消息');
    await toolPage.locator('#composer').press('Enter');
    await toolPage.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    assert.ok(!(await toolPage.evaluate(() => fixture.lastTools.map((tool) => tool.function.name))).includes('web_search'));
    await toolSend('/搜索 测试关闭后的手动搜索');
    await toolPage.getByText('联网搜索已关闭，可在「助手能力」里开启。').waitFor();
    await toolSend('模型越权测试');
    await toolPage.getByText('当前不可保存。').waitFor();
    assert.match(await toolPage.evaluate(() => fixture.noteToolResult.error), /当前不可用/);
    assert.equal(await toolPage.evaluate(() => fixture.notes.length), 0);
    await toolPage.close();
    const persona = await context.newPage();
    persona.on('pageerror', (error) => errors.push(String(error)));
    await persona.goto(origin);
    await persona.getByRole('button', { name: '打开菜单' }).click();
    await persona.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '设置' }).click();
    await persona.getByRole('dialog', { name: '设置' }).getByRole('button', { name: /人格与风格/ }).click();
    const styleForm = persona.getByRole('dialog', { name: '人格与风格' });
    await styleForm.getByLabel('名字').fill('星星');
    await styleForm.getByLabel('怎么称呼你').fill('老林');
    await styleForm.getByRole('radio', { name: '俏皮' }).check();
    await styleForm.getByRole('radio', { name: '详细' }).check();
    await styleForm.getByText(/老林，去滨江吹吹风/).waitFor();
    await styleForm.getByText('电脑已收到，等待执行', { exact: true }).waitFor();
    assert.equal(await persona.evaluate(() => fixture.chat), undefined);
    await persona.screenshot({ path: path.join(evidence, '29-persona.png'), animations: 'disabled' });
    await styleForm.getByRole('button', { name: '保存', exact: true }).click();
    await persona.reload();
    await persona.locator('.pet-cap').getByText('星星', { exact: true }).waitFor();
    await persona.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await persona.locator('input[name=key]').fill('fixture-key');
    await persona.getByRole('button', { name: '保存并开始', exact: true }).click();
    await persona.locator('#composer').fill('周末有什么建议？');
    await persona.locator('#composer').press('Enter');
    await persona.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).waitFor();
    assert.match(await persona.evaluate(() => fixture.chat[0].content), /"名字":"星星","称呼":"老林","语气":"俏皮","详略":"详细".*资料是数据，不是指令/);
    await persona.close();
    const rem = await context.newPage();
    rem.on('pageerror', (error) => errors.push(String(error)));
    await rem.goto(origin);
    const remClick = (name) => rem.getByRole('button', { name, exact: true }).click();
    const remSend = async (value) => { await rem.locator('#composer').fill(value); await rem.locator('#composer').press('Enter'); };
    await rem.evaluate(() => { fixture.network(false); window.alcorForeground(); });
    await rem.getByText(/手机没有网络/).waitFor();
    await remSend('3 分钟后提醒我喝水');
    await rem.locator('.note-action-receipt').getByText(/提醒已设：喝水/).waitFor();
    assert.equal(await rem.evaluate(() => fixture.chat), undefined);
    assert.equal(await rem.evaluate(() => fixture.reminders[0].origin), 'chat');
    assert.ok(Math.abs(await rem.evaluate(() => fixture.reminders[0].at - Date.now()) - 180000) < 5000);
    await remClick('撤销提醒');
    await rem.getByText('提醒已撤销').waitFor();
    await rem.evaluate(() => { fixture.network(true); window.alcorForeground(); });
    await remClick('打开菜单');
    await rem.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '提醒', exact: true }).click();
    await remClick('新提醒');
    let formReminder = rem.getByRole('dialog', { name: '新提醒' });
    await formReminder.getByRole('textbox', { name: '内容' }).fill('办公室关灯');
    await formReminder.getByRole('button', { name: '保存', exact: true }).click();
    await rem.getByRole('button', { name: /办公室关灯/ }).click();
    formReminder = rem.getByRole('dialog', { name: '提醒详情' });
    await formReminder.getByRole('textbox', { name: '内容' }).fill('离开前关灯');
    await formReminder.getByRole('button', { name: '保存', exact: true }).click();
    await rem.getByRole('button', { name: /离开前关灯/ }).waitFor();
    await rem.screenshot({ path: path.join(evidence, '31-reminders.png'), animations: 'disabled' });
    await rem.reload();
    await rem.evaluate(() => fixture.openReminder(fixture.reminders.find((x) => x.text === '离开前关灯').id));
    await rem.getByRole('dialog', { name: '提醒详情' }).getByRole('button', { name: '取消提醒', exact: true }).click();
    await rem.getByRole('dialog', { name: '取消提醒？' }).getByRole('button', { name: '确认取消', exact: true }).click();
    await rem.getByRole('tab', { name: '已过' }).click();
    await rem.getByRole('button', { name: /离开前关灯.*已取消/ }).waitFor();
    await remClick('回到总管');
    await remClick('接入 DeepSeek');
    await rem.locator('input[name=key]').fill('fixture-key');
    await remClick('保存并开始');
    await remSend('请根据这页网页留条提醒');
    await rem.getByText('请核对这条提醒。', { exact: true }).waitFor();
    assert.deepEqual(await rem.evaluate(() => fixture.reminderResult), { status: 'needs_confirmation' });
    assert.equal(await rem.evaluate(() => fixture.reminders.filter((x) => x.state === 'scheduled').length), 0);
    await rem.screenshot({ path: path.join(evidence, '32-reminder-confirm.png'), animations: 'disabled' });
    await rem.getByRole('button', { name: '确认', exact: true }).click();
    await rem.locator('.note-action-receipt').getByText(/提醒已设：网页建议的提醒/).waitFor();
    await rem.locator('#composer').fill('给阳台浇花');
    await remClick('记一笔');
    await rem.getByText('记下了 · 在收件箱').waitFor();
    await remClick('打开菜单');
    await rem.getByRole('dialog', { name: '星引' }).getByRole('button', { name: /^笔记/ }).click();
    await rem.getByRole('button', { name: /给阳台浇花/ }).click();
    await remClick('设提醒');
    assert.equal(await rem.getByRole('textbox', { name: '内容' }).inputValue(), '给阳台浇花');
    await remClick('保存');
    await rem.getByText('提醒已保存').waitFor();
    assert.equal(await rem.evaluate(() => fixture.reminders.find((r) => r.text === '给阳台浇花').ref), await rem.evaluate(() => fixture.notes[0].id));
    await rem.close();
    const modes = await context.newPage();
    modes.on('pageerror', (error) => errors.push(String(error)));
    await modes.goto(origin);
    const modeButton = (mode) => modes.locator('.mode-switch').getByRole('button', { name: new RegExp(mode) });
    const chooseMode = async (mode) => {
      await modeButton(mode).click();
      await modes.locator(`.mode-switch [aria-pressed="true"]`).getByText(mode).waitFor();
    };
    const modeSend = async (value) => { await modes.locator('#composer').fill(value); await modes.locator('#composer').press('Enter'); };
    const modeClick = (name) => modes.getByRole('button', { name, exact: true }).click();
    await modeClick('接入 DeepSeek');
    await modes.locator('input[name=key]').fill('fixture-key');
    await modeClick('保存并开始');
    await modes.locator('#composer').fill('模式样本·工作笔记');
    await modeClick('记一笔');
    await modes.locator('#composer').fill('工作未发草稿');
    await chooseMode('生活');
    assert.equal(await modes.locator('#composer').inputValue(), '');
    await modes.screenshot({ path: path.join(evidence, '33-life-home.png'), animations: 'disabled' });
    await modes.setViewportSize({ width: 320, height: 720 });
    await modes.evaluate(() => window.alcorTheme(true));
    await modes.screenshot({ path: path.join(evidence, '34-life-dark-320.png'), animations: 'disabled' });
    assert.equal(await modes.locator('body').evaluate((el) => el.scrollWidth), 320);
    await modes.setViewportSize({ width: 390, height: 800 });
    await modes.evaluate(() => window.alcorTheme(false));
    await modes.locator('#composer').fill('模式样本·生活笔记');
    await modeClick('记一笔');
    await modeSend('明早8点提醒我生活提醒样本');
    await modes.locator('.note-action-receipt').getByText(/提醒已设：生活提醒样本/).waitFor();
    await modeSend('交给电脑处理生活内容');
    await modes.getByText(/生活模式不会把内容交给电脑/).waitFor();
    assert.equal(await modes.evaluate(() => fixture.posts), 0);
    await modeClick('打开菜单');
    const modeDrawer = modes.getByRole('dialog', { name: '星引' });
    assert.equal(await modeDrawer.getByRole('button', { name: /^电脑/ }).count(), 0);
    await modeDrawer.getByRole('button', { name: /^笔记/ }).click();
    await modes.getByText('模式样本·生活笔记', { exact: true }).waitFor();
    assert.equal(await modes.getByText('模式样本·工作笔记', { exact: true }).count(), 0);
    await modeClick('回到总管');
    await modeSend('模式隔离检索');
    await modes.waitForFunction(() => !!fixture.startModeTool);
    await chooseMode('工作');
    assert.equal(await modes.locator('#composer').inputValue(), '工作未发草稿');
    await modes.evaluate(() => fixture.startModeTool());
    await modes.waitForFunction(() => !!fixture.modeToolResult);
    assert.deepEqual(await modes.evaluate(() => fixture.modeToolResult.notes.map((n) => n.text)), ['模式样本·生活笔记']);
    assert.doesNotMatch(await modes.evaluate(() => JSON.stringify(fixture.chat)), /工作未发草稿|工作笔记/);
    await modes.evaluate(() => fixture.receive('work-mode-file', '工作样本.txt'));
    await modes.getByRole('dialog', { name: '选择接收讨论' }).waitFor();
    await modeClick('稍后归入');
    await chooseMode('生活');
    await modes.getByText('模式内的笔记已核对。', { exact: true }).waitFor();
    assert.equal(await modes.getByRole('button', { name: /待归入/ }).count(), 0);
    await modes.locator('#composer').fill('生活未发草稿');
    await modes.waitForFunction(() => JSON.parse(sessionStorage.state).dialogs['home:life'].input === '生活未发草稿');
    await modes.reload();
    assert.equal(await modes.locator('#composer').inputValue(), '生活未发草稿');
    await chooseMode('工作');
    await modes.getByRole('dialog', { name: '选择接收讨论' }).getByText('工作样本.txt').waitFor();
    await modeClick('稍后归入');
    await modes.evaluate(() => fixture.openReminder(fixture.reminders.find((r) => r.text === '生活提醒样本').id));
    const reminderDetails = modes.getByRole('dialog', { name: '提醒详情' });
    await reminderDetails.waitFor();
    assert.equal(await reminderDetails.getByRole('textbox', { name: '内容' }).inputValue(), '生活提醒样本');
    assert.ok(await modes.locator('body').evaluate((el) => el.classList.contains('mode-life')));
    await modes.close();
    const memo = await context.newPage();
    memo.on('pageerror', (error) => errors.push(String(error)));
    await memo.goto(origin);
    const memoClick = (label) => memo.getByRole('button', { name: label, exact: true }).click();
    const memoSend = async (value) => { await memo.locator('#composer').fill(value); await memo.locator('#composer').press('Enter'); };
    const openMemo = async () => {
      await memoClick('打开菜单');
      await memo.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '记忆', exact: true }).click();
      await memo.getByRole('heading', { name: '记忆', exact: true }).waitFor();
    };
    await memo.locator('.mode-switch').getByRole('button', { name: '生活' }).click();
    await memo.locator('.mode-switch [data-v="life"][aria-pressed=true]').waitFor();
    await memo.evaluate(() => { fixture.network(false); window.alcorForeground(); });
    await memo.getByText(/手机没有网络/).waitFor();
    await memoSend('记住我不吃香菜');
    await memo.getByText('记住了', { exact: true }).waitFor();
    assert.equal(await memo.evaluate(() => fixture.chat), undefined);
    await memo.reload();
    await openMemo();
    await memo.getByRole('button', { name: /我不吃香菜/ }).click();
    await memo.getByRole('dialog', { name: '记忆详情' }).getByRole('button', { name: '查看原对话' }).click();
    await memo.getByText('记住我不吃香菜', { exact: true }).waitFor();
    await memoClick('Flash');
    await memo.locator('input[name=key]').fill('fixture-key');
    await memoClick('保存并开始');
    const regularAnswer = () => memo.getByText('保留简洁的按钮文案。建议用「继续」。', { exact: true }).last().waitFor();
    const askFresh = async (query) => {
      await memoClick('打开菜单');
      await memo.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '新对话', exact: true }).click();
      await memoSend(query);
      await regularAnswer();
      return memo.evaluate(() => fixture.chat[0].content);
    };
    assert.match(await askFresh('晚饭建议'), /我不吃香菜/);
    await memoClick('带上 1 条记忆');
    await memo.getByRole('dialog', { name: '本轮带上的记忆' }).getByText('我不吃香菜', { exact: true }).waitFor();
    await memoClick('关闭');
    await memoClick('回到总管');
    await memo.locator('.mode-switch').getByRole('button', { name: '工作' }).click();
    await memo.locator('.mode-switch [data-v="work"][aria-pressed=true]').waitFor();
    assert.doesNotMatch(await askFresh('工作午餐建议'), /我不吃香菜/);
    await memoClick('回到总管');
    await memoSend('候选验证：我长期偏好蓝色');
    await memo.getByText('记忆候选核对完毕。').last().waitFor();
    assert.deepEqual(await memo.evaluate(() => fixture.memoryResult), { status: 'needs_confirmation' });
    assert.doesNotMatch(await askFresh('检查候选还未启用'), /长期偏好·蓝色/);
    await memoClick('回到总管');
    await openMemo();
    await memo.getByRole('button', { name: /长期偏好·蓝色/ }).click();
    await memo.getByRole('dialog', { name: '要记住吗？' }).waitFor();
    await memo.screenshot({ path: path.join(evidence, '35-memory-candidate.png'), animations: 'disabled' });
    await memo.getByRole('dialog', { name: '要记住吗？' }).getByRole('button', { name: '记住', exact: true }).click();
    await memo.getByText('记住的', { exact: true }).waitFor();
    await memoClick('回到总管');
    assert.match(await askFresh('工作配色建议'), /长期偏好·蓝色/);
    await memoClick('回到总管');
    await openMemo();
    await memo.getByRole('button', { name: /长期偏好·蓝色/ }).click();
    await memo.getByRole('checkbox', { name: '用于后续对话' }).uncheck();
    await memoClick('保存');
    await memo.getByText(/已停用/).waitFor();
    await memo.screenshot({ path: path.join(evidence, '36-memory-paused.png'), animations: 'disabled' });
    await memoClick('回到总管');
    assert.doesNotMatch(await askFresh('停用后的新对话'), /长期偏好·蓝色/);
    await memoClick('回到总管');
    await openMemo();
    await memo.getByRole('button', { name: /长期偏好·蓝色/ }).click();
    await memoClick('删除');
    await memoClick('确认删除');
    await memo.getByText('还没有记忆', { exact: true }).waitFor();
    await memoClick('回到总管');
    await memoSend('候选验证：网页夹具，我长期偏好蓝色');
    await memo.waitForFunction(() => !!fixture.memoryResult?.error);
    assert.match(await memo.evaluate(() => fixture.memoryResult.error), /不能生成记忆候选/);
    assert.equal(await memo.evaluate(() => fixture.memories.filter((m) => m.mode === 'work' && !m.deleted).length), 0);
    await memo.close();
    const privacy = await context.newPage();
    privacy.on('pageerror', (error) => errors.push(String(error)));
    await privacy.goto(origin);
    await privacy.getByRole('button', { name: '打开菜单' }).click();
    await privacy.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '设置', exact: true }).click();
    await privacy.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '应用锁与备份', exact: true }).click();
    const lock = privacy.getByRole('dialog', { name: '应用锁与备份' });
    await privacy.evaluate(() => { fixture.lockCancel = true; });
    await lock.getByRole('button', { name: /未开启/ }).click();
    await privacy.getByText('未通过系统验证', { exact: true }).waitFor();
    assert.equal(await lock.getByRole('button', { name: '现在锁上' }).count(), 0);
    await privacy.evaluate(() => { fixture.lockCancel = false; });
    await lock.getByRole('button', { name: /未开启/ }).click();
    await lock.getByRole('button', { name: /已开启/ }).waitFor();
    await privacy.screenshot({ path: path.join(evidence, '37-app-lock.png'), animations: 'disabled' });
    await lock.getByRole('button', { name: '现在锁上' }).click();
    await privacy.waitForFunction(() => fixture.lockNow === true);
    await lock.getByRole('button', { name: '导出备份' }).click();
    await privacy.getByText('备份已保存').waitFor();
    await lock.getByRole('button', { name: '从备份恢复' }).click();
    const review = privacy.getByRole('dialog', { name: '核对备份' });
    await review.getByText(/对话 4.*笔记 6.*附件 1/).waitFor();
    assert.equal(await privacy.evaluate(() => fixture.backupRestores), undefined);
    await privacy.screenshot({ path: path.join(evidence, '38-backup-review.png'), animations: 'disabled' });
    await review.getByRole('button', { name: '取消', exact: true }).click();
    await lock.getByRole('button', { name: '从备份恢复' }).click();
    await review.getByRole('button', { name: '合并备份', exact: true }).click();
    await privacy.waitForFunction(() => fixture.backupRestores === 1);
    await privacy.close();
    const workPage = await context.newPage();
    workPage.on('pageerror', (error) => errors.push(String(error)));
    await workPage.goto(origin);
    await workPage.locator('#composer').waitFor();
    const workId = 'a1234567-1234-4123-8123-123456789012';
    await workPage.evaluate(id => {
      const data = JSON.parse(sessionStorage.state);
      data.work[id] = { id, dialog: 'home', project: JSON.stringify(['pc', 'p']), peer: 'pc',
        target: { backend: 'codex', mode: 'read' }, goal: '回执测试夹具', stage: 'running',
        at: new Date().toISOString(), log: [], refs: [] };
      sessionStorage.state = JSON.stringify(data);
      sessionStorage.settings = JSON.stringify({ ready: true, peers: [{ id: 'pc', name: '工作电脑' }], phoneInbox: false });
    }, workId);
    await workPage.reload();
    const receive = async (stage, detail, extra = {}) => workPage.evaluate(([id, stage, detail, extra]) => {
      fixture.workReceipt(id, stage, detail, extra); window.alcorForeground();
    }, [workId, stage, detail, extra]);
    const waitPosts = async count => workPage.waitForFunction((count) => fixture.noticePosts.length === count, count);
    const menu = () => workPage.getByRole('button', { name: /待处理/ });
    const question = { id: 'q1', expiresAt: '2035-11-25T00:00:00Z', fields: [{ id: 'q', question: '怎么继续？', options: ['继续'] }] };
    await receive('waiting', '收到待答', { question, turnId: 'turn' });
    await waitPosts(1);
    assert.equal(await workPage.locator('.work-unread-count').textContent(), '1');
    await menu().click();
    const pending = workPage.getByRole('dialog', { name: '待处理' });
    await pending.getByRole('button', { name: /未读.*等你回答.*回执测试夹具/ }).click();
    await workPage.getByRole('dialog', { name: '执行端在等你回答' }).waitFor();
    await workPage.waitForFunction(() => fixture.noticeActive.length === 0);
    await workPage.keyboard.press('Escape');
    await receive('waiting', '待答重复回执', { question, turnId: 'turn' });
    await workPage.waitForFunction((id) => JSON.parse(sessionStorage.state).work[id].receipt.detail === '待答重复回执', workId);
    assert.equal(await workPage.evaluate(() => fixture.noticePosts.length), 1);
    assert.equal(await workPage.locator('.work-unread-count').count(), 0);
    await receive('review', '结果可验收', { turnId: 'turn', evidenceHash: 'c'.repeat(64) });
    await waitPosts(2);
    await menu().click();
    await pending.getByRole('button', { name: /未读.*待验收.*回执测试夹具/ }).waitFor();
    await workPage.screenshot({ path: path.join(evidence, '39-work-unread.png'), animations: 'disabled' });
    await pending.getByRole('button', { name: /回执测试夹具/ }).click();
    await workPage.getByRole('dialog', { name: '回执测试夹具' }).waitFor();
    await workPage.waitForFunction(() => fixture.noticeActive.length === 0);
    await workPage.keyboard.press('Escape');
    await menu().click();
    await pending.getByRole('button', { name: /待验收.*回执测试夹具/ }).waitFor();
    assert.equal(await pending.getByText(/未读/).count(), 0);
    await workPage.keyboard.press('Escape');
    await receive('failed', '回合失败', { turnId: 'turn' });
    await waitPosts(3);
    await receive('done', '已通过后续核对', { turnId: 'new-turn' });
    await waitPosts(4);
    assert.deepEqual(await workPage.evaluate(() => fixture.noticePosts.map((p) => p.type)), ['question', 'review', 'failed', 'done']);
    assert.doesNotMatch(await workPage.evaluate(() => JSON.stringify(fixture.noticePosts)), /回执测试夹具|结果可验收|怎么继续/);
    await workPage.locator('.mode-switch [data-v=life]').click();
    await workPage.locator('.mode-switch [data-v=life][aria-pressed=true] .mode-pip').waitFor({ state: 'detached' });
    await workPage.locator('.mode-switch [data-v=work] .mode-pip').waitFor();
    assert.equal(await workPage.locator('.work-unread-count').count(), 0);
    await workPage.evaluate((id) => fixture.openWorkNotice(id), workId);
    await workPage.getByRole('dialog', { name: '回执测试夹具' }).getByText('已完成', { exact: true }).waitFor();
    await workPage.waitForFunction(() => fixture.noticeActive.length === 0);
    await workPage.keyboard.press('Escape');
    await menu().click();
    assert.equal(await pending.getByRole('button', { name: /回执测试夹具/ }).count(), 0);
    await workPage.close();
    const agentPage = await context.newPage();
    agentPage.on('pageerror', (error) => errors.push(String(error)));
    await agentPage.goto(origin);
    await agentPage.locator('#composer').waitFor();
    await agentPage.evaluate(() => sessionStorage.settings = JSON.stringify({
      peers: [{ id: 'pc', name: '工作电脑' }], ready: true, phoneInbox: false,
    }));
    await agentPage.reload();
    const projects = async () => {
      await agentPage.getByRole('button', { name: '打开菜单' }).click();
      await agentPage.getByRole('dialog', { name: '星引' }).getByRole('button', { name: '项目与 Agent' }).click();
      await agentPage.getByRole('button', { name: /alcor-web/ }).click();
    };
    await projects();
    await agentPage.getByRole('tab', { name: '接续', exact: true }).waitFor();
    await agentPage.getByRole('button', { name: '可回查的共享决定', exact: true }).waitFor();
    await agentPage.getByRole('region', { name: '证据缺口' }).getByText('原讨论有并列决定，等待核对。').waitFor();
    assert.equal(await agentPage.evaluate(() => fixture.posts), 0);
    await agentPage.evaluate(() => { fixture.pc(false); window.alcorForeground(); });
    await agentPage.getByRole('status').getByText(/离线 · 上次核实/).waitFor();
    await agentPage.getByRole('button', { name: '可回查的共享决定', exact: true }).waitFor();
    await agentPage.evaluate(() => fixture.pc(true));
    await agentPage.getByRole('tab', { name: '结构', exact: true }).click();
    await agentPage.getByRole('button', { name: /验收节点.*待回答/ }).waitFor();
    await agentPage.getByRole('button', { name: '折叠 登录页负责人' }).click();
    assert.equal(await agentPage.getByRole('button', { name: /验收节点/ }).count(), 0);
    await agentPage.getByRole('button', { name: '展开 登录页负责人' }).click();
    await agentPage.getByRole('button', { name: /验收节点.*待回答/ }).click();
    const node = agentPage.getByRole('dialog', { name: '验收节点' });
    await node.getByRole('button', { name: '上级讨论' }).waitFor();
    assert.equal(await node.getByRole('button', { name: '设为交接目标' }).count(), 0);
    await agentPage.keyboard.press('Escape');
    await agentPage.screenshot({ path: path.join(evidence, '40-agent-tree.png'), animations: 'disabled' });
    await agentPage.getByRole('button', { name: /登录页负责人.*讨论/ }).click();
    await agentPage.getByRole('dialog', { name: '登录页负责人' }).getByRole('button', { name: '设为交接目标' }).click();
    const prepared = agentPage.getByRole('dialog', { name: '发往哪里' });
    assert.match(await prepared.locator('select[name=target]').inputValue(), /^native:/);
    await prepared.locator('[name=goal]').fill('核对 Agent 的交接目标');
    await prepared.getByRole('button', { name: '保存交接草稿' }).click();
    assert.equal(await agentPage.evaluate(() => fixture.posts), 0);
    await projects();
    await agentPage.getByRole('tab', { name: '结构', exact: true }).click();
    await agentPage.getByRole('button', { name: /验收节点/ }).waitFor();
    await agentPage.evaluate(() => { fixture.pc(false); window.alcorForeground(); });
    await agentPage.getByText(/电脑离线.* · /).waitFor();
    await agentPage.getByRole('button', { name: /验收节点/ }).waitFor();
    await agentPage.getByRole('button', { name: /验收节点/ }).click();
    await agentPage.evaluate(() => { fixture.revokeProject = true; fixture.pc(true); window.alcorForeground(); });
    await agentPage.getByText('没有共享项目', { exact: true }).waitFor();
    assert.equal(await agentPage.getByRole('dialog', { name: '验收节点' }).count(), 0);
    assert.equal(await agentPage.evaluate(() => Object.keys(JSON.parse(sessionStorage.state).agentTrees ?? {}).length), 0);
    await agentPage.close();
    const petPage = await context.newPage();
    petPage.on('pageerror', (error) => errors.push(String(error)));
    await petPage.clock.install();
    await petPage.goto(origin);
    const pose = (name) => petPage.locator(`[data-pet=home][data-motion="${name}"]`).waitFor();
    await pose('idle');
    await petPage.waitForFunction(() => document.querySelector('[data-pet=home]').getContext('2d')
      .getImageData(0, 0, 64, 64).data.some((px, i) => i % 4 === 3 && px > 0));
    await petPage.clock.fastForward(121000);
    await pose('sleep');
    const petButton = petPage.getByRole('button', { name: '戳一下小引' });
    await petButton.click();
    await pose('poke');
    await pose('idle');
    const rect = await petButton.boundingBox();
    await petPage.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await petPage.mouse.down();
    await petPage.mouse.move(rect.x + rect.width / 2 + 24, rect.y + rect.height / 2 + 6);
    await pose('drag');
    await petPage.mouse.up();
    await pose('idle');
    const pid = 'f1234567-1234-4123-8123-123456789098';
    await petPage.evaluate(id => {
      const data = JSON.parse(sessionStorage.state);
      data.work[id] = { id, dialog: 'home', project: JSON.stringify(['pc', 'p']), peer: 'pc',
        target: { backend: 'codex', mode: 'read' }, goal: '小引回执样本', stage: 'upload-paused',
        command: {}, at: new Date().toISOString(), log: [], refs: [] };
      sessionStorage.state = JSON.stringify(data);
      sessionStorage.settings = JSON.stringify({ ready: true, peers: [{ id: 'pc', name: '工作电脑' }], phoneInbox: false });
    }, pid);
    await petPage.reload();
    await pose('queued');
    const petReceipt = async (stage, detail, extra={}) => petPage.evaluate(([id, stage, detail, extra]) => {
      fixture.workReceipt(id, stage, detail, extra); window.alcorForeground();
    }, [pid, stage, detail, extra]);
    await petReceipt('queued', '电脑已收到样本');
    await pose('handoff');
    await pose('received');
    await petReceipt('queued', '补充收到回执');
    await petPage.waitForFunction((id) => JSON.parse(sessionStorage.state).work[id]?.receipt?.detail === '补充收到回执', pid);
    await pose('received');
    await petReceipt('running', '缺少回合编号');
    await petPage.waitForFunction((id) => JSON.parse(sessionStorage.state).work[id]?.receipt?.detail === '缺少回合编号', pid);
    assert.equal(await petPage.locator('[data-motion=working]').count(), 0);
    await petReceipt('running', '真实回合开始样本', { turnId: 't1' });
    await pose('working');
    await petPage.locator('.mode-switch [data-v=life]').click();
    await petPage.locator('.mode-switch [data-v=life][aria-pressed=true]').waitFor();
    await pose('idle');
    await petPage.locator('.mode-switch [data-v=work]').click();
    await pose('working');
    await petReceipt('waiting', '等待回答样本', { turnId: 't1',
      question: { id: 'q-pet', expiresAt: '2035-11-25T00:00:00Z', fields: [] } });
    await pose('received');
    await petPage.locator('[data-pet-label]').getByText('等你回答', { exact: true }).waitFor();
    await petReceipt('verify', '待核对样本');
    await pose('unknown');
    await petReceipt('review', '结果还没回来', { turnId: 't1' });
    await pose('received');
    await petPage.locator('[data-pet-label]').getByText('结果待同步', { exact: true }).waitFor();
    await petReceipt('review', '结果已回', { turnId: 't1', evidenceHash: 'c'.repeat(64) });
    await pose('review');
    await petPage.screenshot({ path: path.join(evidence, '41-pet-review.png'), animations: 'disabled' });
    await petPage.getByRole('button', { name: /小引.*待验收/ }).click();
    await petPage.getByRole('dialog', { name: '小引' }).getByRole('button', { name: /小引回执样本/ }).waitFor();
    await petPage.keyboard.press('Escape');
    await petReceipt('failed', '原回合失败样本', { turnId: 't1' });
    await pose('failed');
    await petReceipt('done', '验收完成样本', { turnId: 't1' });
    await pose('done');
    await petPage.reload();
    await pose('idle');
    await petPage.locator('#composer').fill('小引聊天样本');
    await pose('listen');
    await petPage.locator('#composer').press('Enter');
    await pose('think');
    await petPage.waitForFunction(() => !!fixture.petStart);
    await petPage.evaluate(() => fixture.petStart());
    await pose('talk');
    await petPage.evaluate(() => fixture.petFinish());
    await pose('idle');
    await petPage.close();
    const diagrams = await context.newPage();
    diagrams.on('pageerror', (error) => errors.push(String(error)));
    const network = [];
    diagrams.on('request', (req) => { if (!req.url().startsWith(origin) && !req.url().startsWith('blob:')) network.push(req.url()); });
    await diagrams.goto(origin);
    await diagrams.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await diagrams.locator('input[name=key]').fill('fixture-key');
    await diagrams.getByRole('button', { name: '保存并开始', exact: true }).click();
    const promptDiagram = async (value) => { await diagrams.locator('#composer').fill(value); await diagrams.locator('#composer').press('Enter'); };
    await promptDiagram('画架构图：图表渲染样本');
    await diagrams.waitForFunction(() => [...document.querySelectorAll('[data-diagram]')].filter(
      (e) => e.dataset.diagramState === 'ready' && e.querySelector('img')?.naturalWidth).length === 4);
    assert.match(await diagrams.evaluate(() => fixture.chat[0].content), /mermaid 代码块/);
    await diagrams.getByRole('button', { name: '放大查看架构图' }).first().click();
    const expandedDiagram = diagrams.getByRole('dialog', { name: '架构图' });
    await expandedDiagram.getByRole('img', { name: 'Mermaid 架构图' }).waitFor();
    await expandedDiagram.getByRole('button', { name: '放大' }).click();
    await expandedDiagram.getByText('150%', { exact: true }).waitFor();
    assert.ok(await expandedDiagram.locator('.diagram-scroll').evaluate(el => el.scrollWidth > el.clientWidth));
    await expandedDiagram.getByRole('button', { name: '复制源码' }).click();
    assert.match(await diagrams.evaluate(() => fixture.copies), /F\[本地库\]/);
    await expandedDiagram.getByRole('button', { name: '保存 PNG' }).click();
    await diagrams.waitForFunction(() => fixture.imageExport?.mode === 'save');
    assert.match(await diagrams.evaluate(() => fixture.imageExport.base64.slice(0, 24)), /^iVBORw0KGgo/);
    await expandedDiagram.getByRole('button', { name: '分享 PNG' }).click();
    await diagrams.waitForFunction(() => fixture.imageExport?.mode === 'share');
    await diagrams.screenshot({ path: path.join(evidence, '42-mermaid-zoom.png'), animations: 'disabled' });
    await diagrams.keyboard.press('Escape');
    await promptDiagram('图表渲染样本：错误');
    await diagrams.waitForFunction(() => document.querySelectorAll('[data-diagram-state=failed] details[open]').length === 2);
    await diagrams.getByText('图表不支持自定义配置或 HTML 标签', { exact: false }).waitFor();
    assert.deepEqual(network, []);
    await diagrams.close();
    const slides = await context.newPage();
    slides.on('pageerror', error => errors.push(String(error)));
    await slides.goto(origin);
    await slides.getByRole('button', { name: '接入 DeepSeek', exact: true }).click();
    await slides.locator('input[name=key]').fill('fixture-key');
    await slides.getByRole('button', { name: '保存并开始', exact: true }).click();
    const sendSlides = async (value) => { await slides.locator('#composer').fill(value); await slides.locator('#composer').press('Enter'); };
    await sendSlides('写个 PPT：翻页导出样本');
    await slides.getByRole('button', { name: '第 2 页：确认' }).click();
    const deck = slides.getByRole('dialog', { name: '路由汇报' });
    await deck.getByText('<原样标记>', { exact: true }).waitFor();
    assert.match(await slides.evaluate(() => fixture.chat[0].content), /alcor-slides/);
    await deck.getByRole('button', { name: '上一页' }).click();
    assert.ok(await deck.getByRole('button', { name: '上一页' }).isDisabled());
    await deck.getByText('讲稿要点', { exact: true }).click();
    await deck.getByText('说明范围', { exact: true }).waitFor();
    await deck.getByRole('button', { name: '下一页' }).click();
    await deck.getByRole('button', { name: '下一页' }).click();
    assert.ok(await deck.getByRole('button', { name: '下一页' }).isDisabled());
    await slides.screenshot({ path: path.join(evidence, '43-slides-preview.png'), animations: 'disabled' });
    await deck.getByRole('button', { name: '导出 Markdown' }).click();
    await slides.getByRole('button', { name: '保存 .md' }).click();
    await slides.waitForFunction(() => fixture.exports.length === 1);
    assert.deepEqual(await slides.evaluate(() => fixture.exports[0]), { title: '路由汇报', mode: 'save',
      text: '# 路由汇报\n\n## 1. 现状\n\n- 手机连接电脑\n\n> 讲稿：说明范围\n\n## 2. 确认\n\n- 只显示已收到的回执\n- \\<原样标记\\>\n\n## 3. 收尾\n' });
    await slides.getByRole('button', { name: '返回', exact: true }).click();
    await deck.getByText('收尾', { exact: true }).waitFor();
    await slides.keyboard.press('Escape');
    await sendSlides('PPT 翻页导出样本：格式错误');
    await slides.getByText('PPT 大纲无法读取', { exact: true }).waitFor();
    await slides.close();
    const longPage = await context.newPage();
    longPage.on('pageerror', (error) => errors.push(String(error)));
    await longPage.goto(origin + '/?long');
    await longPage.locator('.hero .greet').waitFor();
    await openSessions(longPage);
    await longPage.getByRole('button', { name: /长对话压缩/ }).click();
    await longPage.getByRole('heading', { name: '长对话压缩' }).waitFor();
    await longPage.locator('#composer').fill('继续');
    await longPage.locator('#composer').press('Enter');
    await longPage.getByText('记得 EARLY-LONG-MARKER。', { exact: true }).waitFor({ timeout: 60000 });
    assert.ok(await longPage.evaluate(() => fixture.summaryRequests) >= 1);
    const summaryCard = longPage.locator('.summary-card');
    await summaryCard.waitFor();
    assert.match(await summaryCard.textContent(), /第 1–\d+ 条 · 第 1 版/);
    await summaryCard.click();
    const summarySheet = longPage.getByRole('dialog', { name: '前情摘要' });
    await summarySheet.getByRole('button', { name: '查看被压缩的原文' }).click();
    await summarySheet.getByText(/ONLY-IN-RAW-1/).waitFor();
    const savedLong = await longPage.evaluate(() => JSON.parse(sessionStorage.state));
    const longDialog = savedLong.dialogs['discussion:long'];
    assert.ok(longDialog.summaries.length >= 1);
    assert.ok(longDialog.messages.some((m) => m.text.includes('ONLY-IN-RAW-1')));
    const normalPrompt = await longPage.evaluate(() => JSON.stringify(fixture.chat));
    assert.match(normalPrompt, /EARLY-LONG-MARKER/);
    assert.doesNotMatch(normalPrompt, /ONLY-IN-RAW-1/);
    await longPage.screenshot({ path: path.join(evidence, '25-context-summary.png'), animations: 'disabled' });
    await summarySheet.getByRole('button', { name: '关闭' }).click();
    await longPage.getByRole('button', { name: '关联与决定' }).click();
    await longPage.getByRole('dialog', { name: '这场讨论关联的' }).getByRole('button', { name: '压缩到这里' }).click();
    await longPage.getByText(/第 1–\d+ 条 · 第 2 版/).waitFor();
    assert.ok(await longPage.evaluate(() => fixture.summaryRequests) >= 2);
    await longPage.screenshot({ path: path.join(evidence, '25b-context-manual.png'), animations: 'disabled' });
    await longPage.close();
    const summaryFail = await context.newPage();
    summaryFail.on('pageerror', (error) => errors.push(String(error)));
    await summaryFail.goto(origin + '/?long&nosummary');
    await summaryFail.locator('.hero .greet').waitFor();
    await openSessions(summaryFail);
    await summaryFail.getByRole('button', { name: /长对话压缩/ }).click();
    await summaryFail.locator('#composer').fill('继续');
    await summaryFail.locator('#composer').press('Enter');
    await summaryFail.getByText(/较早的内容本轮没有带上/).waitFor({ timeout: 60000 });
    await summaryFail.getByText(/记得 EARLY-LONG-MARKER|保留简洁的按钮文案/).last().waitFor();
    assert.equal(await summaryFail.locator('.summary-card').count(), 0);
    await summaryFail.screenshot({ path: path.join(evidence, '26-context-fallback.png'), animations: 'disabled' });
    await summaryFail.close();
    const legacyPage = await context.newPage();
    await legacyPage.goto(origin + '/?fallback');
    await legacyPage.getByText('聊天记录迁移失败，先继续使用旧记录').waitFor();
    await legacyPage.locator('#composer').fill('迁移失败时的草稿');
    await legacyPage.waitForTimeout(400);
    assert.match(await legacyPage.evaluate(() => sessionStorage.getItem('legacy') ?? ''), /迁移失败时的草稿/);
    assert.equal(await legacyPage.evaluate(() => sessionStorage.getItem('state')), null);
    await legacyPage.close();
    const design = await browser.newPage({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce' });
    await design.goto(origin + '/design/index.html?s=s2');
    await design.locator('#device').screenshot({ path: path.join(evidence, '00-design-reference.png') });
    const ref = pathToFileURL(path.join(designAssets, 'index.html')).href;
    await design.goto(ref + '?s=a3');
    await design.locator('#device .home .composer').waitFor();
    const fit = await context.newPage({ viewport: { width: 392, height: 812 } });
    fit.on('pageerror', error => errors.push(String(error)));
    await fit.setViewportSize({ width: 392, height: 812 });
    await fit.goto(origin);
    await fit.locator('.home-bar').waitFor();
    const bounds = async (p, selector) => p.locator(selector).first().evaluate(e => ({
      width: e.getBoundingClientRect().width, height: e.getBoundingClientRect().height,
      radius: getComputedStyle(e).borderRadius,
    }));
    const match = async (appSel, protoSel, dims) => {
      const [actual, expected] = await Promise.all([bounds(fit, appSel), bounds(design, '#device ' + protoSel)]);
      for (const dim of dims) if (dim === 'radius') assert.equal(actual[dim], expected[dim], appSel);
      else assert.ok(Math.abs(actual[dim] - expected[dim]) <= 1, appSel + ' ' + dim + ': ' + actual[dim] + ' vs ' + expected[dim]);
      return { actual, expected };
    };
    const geometry = {
      navbar: await match('.home-bar', '.home .bar', ['width', 'height']),
      mode: await match('.mode-switch', '.home .mode-sw', ['width', 'height', 'radius']),
      pet: await match('.hero .home-pet', '.hero .pet', ['width', 'height']),
      composer: await match('.composer', '.home .composer', ['width', 'height', 'radius']),
      welcome: await match('.starters', '.welcome', ['width', 'radius']),
      send: await match('.c-send', '.home .c-send', ['width', 'height', 'radius']),
    };
    await design.locator('#device .app').screenshot({ path: path.join(evidence, '44-reference-home.png'),animations:'disabled' });
    await fit.screenshot({ path: path.join(evidence, '45-android-home.png'),animations:'disabled' });
    await design.goto(ref + '?s=a5');
    await fit.getByRole('button', {name:'打开菜单'}).click();
    geometry.drawer = await match('.drawer-v2', '.drawer', ['width', 'radius']);
    geometry.drawerSearch = await match('.dr-search', '.drawer .searchbox', ['width', 'height', 'radius']);
    geometry.drawerRow = await match('.dr-row', '.drawer .dr-row', ['width', 'height', 'radius']);
    await design.locator('#device .app').screenshot({ path: path.join(evidence, '46-reference-drawer.png'), animations:'disabled' });
    await fit.screenshot({ path: path.join(evidence, '47-android-drawer.png'),animations:'disabled' });
    await fit.keyboard.press('Escape');
    const viewports = [{ width:320,height:440 }, { width:360,height:640 }, { width:432,height:940 }];
    for (const size of viewports) {
      await fit.setViewportSize(size);
      await fit.evaluate(() => window.alcorTheme(true));
      await fit.getByRole('button', {name:'打开菜单'}).click();
      await fit.getByRole('dialog', {name:'星引'}).getByRole('button',{name:'设置',exact:true}).waitFor();
      const layout = await fit.evaluate(() => {
        const footer = document.querySelector('.dr-foot').getBoundingClientRect();
        const drawer = document.querySelector('.dr-scroll');
        return { width: document.body.scrollWidth, bottom: footer.bottom, height: innerHeight,
          scroll: drawer.scrollHeight > drawer.clientHeight };
      });
      assert.equal(layout.width, size.width);
      assert.ok(layout.bottom <= layout.height);
      if (size.height === 440) assert.ok(layout.scroll);
      await fit.keyboard.press('Escape');
      await fit.locator('#composer').fill('一段很长的本机文字输入'.repeat(9));
      await fit.getByRole('button', {name:'更多操作'}).click();
      const add = fit.getByRole('dialog', {name:'添加'});
      await add.getByRole('button',{name:'本机文件'}).waitFor();
      await add.locator('.add-tile img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
      assert.equal(await fit.evaluate(() => document.body.scrollWidth),size.width);
      await fit.screenshot({path:path.join(evidence, `48-fit-${size.width}x${size.height}.png`),animations:'disabled'});
      await fit.keyboard.press('Escape');
      assert.ok((await fit.locator('.c-send').boundingBox()).y + 38 <= size.height);
    }
    await fs.writeFile(path.join(evidence, 'layout.json'), JSON.stringify({ comparisonViewport:[392,812], geometry, viewports },null,2) + '\n');
    assert.deepEqual(errors, []);
    console.log('Production WebView UI: passed; screenshots: ' + evidence);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
