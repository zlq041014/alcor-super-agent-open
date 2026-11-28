import assert from 'node:assert/strict';
import test from 'node:test';

let connected = true, state = '', pending;
const sent = [];
const at = '2026-11-28T08:00:00Z';
globalThis.window = { AlcorNative: {
  online: () => connected,
  state: () => state,
  commit(value) { state = value; return ''; },
  request(id, op, json) {
    const payload = JSON.parse(json);
    sent.push({ op, payload });
    assert.equal(op, 'desktop');
    assert.ok(['resume', 'catalog'].includes(payload.route));
    pending = value => window.alcorResult(id, 'done', value);
  },
} };
const { desktopKey, dropPeerResumes, load,
  projectResume, refreshPeerCatalog, refreshProjectResume } = await import('../app/src/main/assets/model.js');

const pair = { id: 'a', grant: 'grant-a', online: true, projectResume: true, decisionEvidence: true };
const another = { ...pair, id: 'b', grant: 'grant-b' };
const a = desktopKey('a', 'same-id'), b = desktopKey('b', 'same-id');
const project = (peer, key, version = 'v1') => ({ name: '同名项目', shared: true, id: 'same-id', peer, key, version });
const resume = (text, version = 'v1') => ({ allowed: true, projectId: 'same-id', version, at, changes: [], pending: [], gaps: [],
  decisions: [{ id: 'one', text, at, secret: 'not a projected field',
    target: { kind: 'decision', id: 'one', discussion: 'd', version: 'decision-v1', quote: 'requires read-only evidence API' } }] });
function fixture() {
  connected = true;
  sent.length = 0;
  state = JSON.stringify({ dialogs: {}, work: {}, peers: { a: pair, b: another },
    projects: { [a]: project('a', a), [b]: project('b', b) } });
  return load();
}
async function fill(data, key, text) {
  const job = refreshProjectResume(data, key, () => true);
  pending({ value: resume(text) });
  await job;
}

test('only scoped display fields survive reopening offline, including the verification time', async () => {
  const data = fixture();
  await fill(data, a, '仅 A 共享');
  await fill(data, b, '仅 B 共享');
  connected = false;
  const reloaded = load();
  reloaded.peers.a.online = reloaded.peers.b.online = false;
  assert.equal(projectResume(reloaded, a).at, at);
  assert.equal(projectResume(reloaded, a).decisions[0].text, '仅 A 共享');
  assert.equal(projectResume(reloaded, b).decisions[0].text, '仅 B 共享');
  assert.doesNotMatch(state, /not a projected field|requires read-only evidence/);
  await refreshProjectResume(reloaded, a, () => true);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(row => row.payload.route === 'resume'));
});

test('late old responses, denied scope, and a pairing replacement cannot restore a copy', async () => {
  const data = fixture();
  await fill(data, a, 'A 已缓存');
  await fill(data, b, 'B 已缓存');
  // An authorized read may still be in flight when the catalog changes.
  const late = refreshProjectResume(data, a, () => true), lateReply = pending;
  const refresh = refreshPeerCatalog(data, pair, () => true);
  pending({ value: { at, capabilities: { projectResume: true, decisionEvidence: true },
    projects: [{ id: 'same-id', name: '同名项目', version: 'v2' }], discussions: [] } });
  await refresh;
  lateReply({ value: resume('旧授权的迟到内容') });
  await late;
  assert.equal(projectResume(data, a), undefined);
  assert.doesNotMatch(state, /A 已缓存|旧授权/);
  assert.equal(projectResume(data, b).decisions[0].text, 'B 已缓存');
  const fresh = refreshProjectResume(data, a, () => true);
  pending({ value: resume('A 新授权', 'v2') });
  await fresh;
  const outside = refreshProjectResume(data, b, () => false);
  pending({ value: { allowed: false } });
  await assert.rejects(outside, /撤回/);
  assert.doesNotMatch(state, /B 已缓存/);
  const oldPair = refreshProjectResume(data, a, () => true);
  dropPeerResumes(data, 'a');
  data.peers.a.grant = 'grant-new';
  pending({ value: resume('旧配对迟到内容', 'v2') });
  await oldPair;
  assert.equal(projectResume(data, a), undefined);
  assert.equal(data.projectResumeCache, undefined);
});
