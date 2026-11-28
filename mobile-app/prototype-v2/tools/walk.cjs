// Click-through check: walk chains of taps across the secondary screens and sheets, report missing targets and page errors.
// Usage: node tools/walk.cjs [outDir] [chain ...]   (needs desktop-app's playwright and local Edge)
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../desktop-app/node_modules/playwright'));

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'evidence'));
const url = s => `file:///${path.join(root, 'index.html').replace(/\\/g, '/')}?s=${s}`;
// Sheets sit above a scrim that shares the closeSheet action, so always close with the button inside the sheet.
const A = (act, arg) => (act === 'closeSheet' ? '#app .sheet [data-act="closeSheet"]' : arg === undefined ? `#app [data-act="${act}"]` : `#app [data-act="${act}"][data-arg="${arg}"]`);

// [name, scenario, ...steps]; a step is a selector to click, a number of ms to wait, or ['fill', selector, text].
const CHAINS = [
  ['inbox-drawer-sessions', 'a1', A('go', 'inbox'), A('back'), A('drawer'), A('go', 'sessions'), A('tabSessions', 'project'), A('tabSessions', 'kind'), ['fill', '#app #q-in', '登录']],
  ['pet-sheet-page', 'a1', '#app .pet-cap', A('go', 'pet'), A('petPlay', 'done'), 1500, A('flip', 'set.pet.dnd')],
  ['mode-switch', 'a1', A('mode', 'life'), A('drawer'), '#app .drawer [data-arg="notes"]', A('back'), A('mode', 'work')],
  ['attach-model', 'a1', A('sheet', 'attach'), A('addMat', 'file'), A('sheet', 'model'), A('setv', 'set.model=pro'), A('setThink', 'max'), A('go', 'model'), A('setv', 'set.provider=custom')],
  ['notes-select', 'b3', A('noteSelOn'), '#app .note-card >> nth=0', '#app .note-card >> nth=1', A('notesToChat')],
  ['notes-tidy', 'b3', A('sheet', 'tidy'), A('tidyRun'), 1800, A('tabNotes', 'filed'), A('tabNotes', 'archived')],
  ['note-detail', 'b4', A('sheet', 'noteremind:n3'), A('noteRemind', 'n3|明早 09:00'), A('snackUndo'), A('noteClear', 'n3'), A('sheet', 'noteproj:n3'), A('noteProj', 'n3|alcor-web'), A('noteToChat', 'n3')],
  ['voice-note', 'b2', A('recSave'), 2400, A('drawer'), A('go', 'notes')],
  ['capture-atts', 'b1', A('capAdd', 'img'), A('capAdd', 'rem'), A('capMode'), A('capSave'), A('snackUndo')],
  ['chat-sheets', 'c2', '#app [data-act="sheet"][data-arg^="memused"]', A('closeSheet'), '#app [data-act="sheet"][data-arg^="export"]', A('closeSheet'), '#app .tools summary', A('sheet', 'chatmenu'), A('compactNow'), 600, '#app .sumline button'],
  ['summary', 'c5', '#app .sumline button', A('closeSheet'), A('sheet', 'chatmenu')],
  ['taint-confirm', 'c4', A('confirmYes'), A('undoSaved')],
  ['saved-undo', 'c3', A('undoSaved')],
  ['offline-draft', 'c7', '#ctl-net', 2600, A('sendDraft'), 4000],
  ['memory', 'd1', A('memKeep', 'm4'), A('snackUndo'), A('sheet', 'mem:m1'), A('memFlip2', 'm1')],
  ['work-memory', 'a1', A('drawer'), '#app .drawer [data-arg="memory"]', A('tabMem', 'project'), A('memFlip', 'm7')],
  ['persona', 'd2', A('setv', 'set.persona.tone=playful'), A('setVerbose', '2'), ['fill', '#app #p-call', '老林'], A('flip', 'set.persona.aiGreet')],
  ['perms', 'd4', A('flip', 'set.tools.web_search'), A('flip', 'set.tools.note_search')],
  ['unlock', 'd5', A('unlock'), A('lockNow'), A('unlock')],
  ['backup-preview', 'd5', A('unlock'), A('sheet', 'restoreBackup')],
  ['reminders', 'e1', A('remFlip', 'r1'), A('tabRem', 'done')],
  ['reminder-editor', 'e1', A('sheet', 'remedit:r1'), ['fill', '#app #rem-body', '办公室关灯'],
    ['fill', '#app #rem-at', '2026-11-26T19:30'], A('remSave', 'r1'), A('sheet', 'remedit')],
  ['weather', 'e2', A('flip', 'set.notif.weather'), A('closeSheet'), A('sheet', 'weather')],
  ['target-sheet', 'f4', A('sheet') + '[data-arg^="target"]', '#app [data-act="taskTarget"][data-arg$="|dsh"]', A('taskConfirm'), A('taskCancel')],
  ['ask-answer', 'a1', A('openEvent', 'e1'), '#app [data-act="answer"]'],
  ['receipt-accept', 'f7', A('taskAccept'), A('back'), A('back')],
  ['inbox-read', 'f8', '#app .item >> nth=0', A('back')],
  ['project-resume', 'f9', A('tabProject', 'tree'), A('tabProject', 'resume')],
  ['decision-evidence', 'f9', A('sheet', 'decisionEvidence:alcor-web|k1'), A('closeSheet')],
  ['agent-node', 'f9', A('tabProject', 'tree'), '#app .node >> nth=2', A('nodeTarget'), A('closeSheet'), A('tabProject', 'convs'), A('tabProject', 'rules')],
  ['computers', 'f10', A('flip', 'flags.relayFiles'), A('back'), A('sheet', 'pair'), A('closeSheet'), A('go', 'computer:work'), A('editRemark'), ['fill', '#app #remark-in', '公司笔记本'], A('remarkSave'), A('back'), A('go', 'computer:home'), A('editRemark'), A('remarkClear')],
  ['conflict', 'f11', A('conflictPick', '继续'), A('closeSheet')],
  ['diagram-zoom', 'g1', A('sheet', 'diagram'), A('diagramScale', '1'), A('diagramScale', '-1')],
  ['slides', 'g2', A('sheet', 'slide:0'), '#app .sheet [data-arg="slide:1"]', '#app .sheet [data-arg="slide:0"]'],
  ['album-apply', 'g3', '#app [data-act="albumFlip"] >> nth=1', A('albumApply'), A('albumDone')],
  ['album-flow', 'a2', A('sheet', 'attach'), A('addMat', 'tidy'), A('albumN', '11'), A('albumSend'), A('albumGo'), 4500],
  ['places-loc', 'e3', '#app .tools summary', '#app [data-act="sheet"][data-arg^="memused"]'],
  ['settings-all', 'h2', A('go', 'model'), A('back'), A('go', 'persona'), A('back'), A('go', 'memory'), A('back'), A('go', 'perms'), A('back'), A('go', 'reminders'), A('back'), A('sheet', 'weather'), A('closeSheet'),
    A('flip', 'set.brief'), A('go', 'computers'), A('back'), A('go', 'projects'), A('back'), A('go', 'notify'), A('back'), A('go', 'usage'), A('back'), A('go', 'storage'), A('back'), A('go', 'privacy'), A('back'), A('go', 'pet'), A('petDemo'), 2500],
  ['launcher-widget', 'a4', A('sysCapture'), ['fill', '#app #cap-in', '从小组件记的一笔'], A('capSave'), A('sysTab', 'press'), A('sysNewChat')],
  ['launcher-share-note', 'a4', A('sysTab', 'share'), A('sysShare', 'note'), A('capSave'), A('sysTab', 'notif'), A('sysNotif', 'work')],
  ['launcher-share-chat', 'a4', A('sysTab', 'share'), A('sysShare', 'chat'), A('back'), A('drawer')],
  ['new-chat', 'a5', A('newChat'), ['fill', '#app #c-in', '随便问一句'], '#app #c-send', 3500, A('quickNote')],
  ['quick-note-typed', 'a1', A('quickNote'), A('snackUndo')],
  ['voice-say', 'f5', A('voice'), A('recSay')],
];

(async () => {
  const requested = process.argv.slice(3);
  const chains = requested.length ? CHAINS.filter(([name]) => requested.includes(name)) : CHAINS;
  if (requested.some((name) => !chains.some(([found]) => found === name))) throw new Error('未知走查场景');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1480, height: 980 }, deviceScaleFactor: 1 });
  const problems = [];
  let where = '';
  page.on('pageerror', e => problems.push(`[pageerror @ ${where}] ${e.message}\n${(e.stack || '').split('\n').slice(1, 4).join('\n')}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`[console @ ${where}] ${m.text()}`); });
  for (const [name, scenario, ...steps] of chains) {
    await page.goto(url(scenario));
    await page.waitForTimeout(300);
    for (const step of steps) {
      where = `${name} > ${Array.isArray(step) ? step.join(' ') : step}`;
      try {
        if (typeof step === 'number') await page.waitForTimeout(step);
        else if (Array.isArray(step)) await page.locator(step[1]).first().fill(step[2], { timeout: 3000 });
        else await page.locator(step).first().click({ timeout: 3000 });
      } catch (e) { problems.push(`[missing @ ${where}] ${String(e.message).split('\n')[0]}`); break; }
      await page.waitForTimeout(220);
    }
    await page.waitForTimeout(350);
    await page.locator('#device').screenshot({ path: path.join(outDir, `walk-${name}.png`) });
    console.log('walk', name);
  }
  await browser.close();
  console.log(problems.length ? `PROBLEMS (${problems.length}):\n${[...new Set(problems)].join('\n')}` : `no problems in ${chains.length} chains`);
  if (problems.length) process.exitCode = 1;
})().catch(e => { console.error(e); process.exit(1); });
