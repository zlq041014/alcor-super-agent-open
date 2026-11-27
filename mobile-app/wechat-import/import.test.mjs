import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { importRelay } from './relay.mjs';

test('微信选中两份同名文件，确认后上传；原请求一次领取，其他凭据不可读取', async t => {
  let now = Date.now();
  const key = randomBytes(32).toString('hex');
  const server = importRelay(key, () => now).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(ok => server.close(ok)); });
  const root = 'http://127.0.0.1:' + server.address().port + '/v1/imports';
  const call = (url, secret, method = 'GET', body) => fetch(url, { method, headers: { Authorization: 'Bearer ' + secret }, body });
  assert.equal((await call(root, 'incorrect', 'POST')).status, 401);
  const create = async () => (await call(root, key, 'POST')).json();
  const job = await create(), url = root + '/' + job.id;
  const other = await create();
  const source = await readFile(new URL('./miniprogram/pages/import/index.js', import.meta.url), 'utf8');
  const bytes = [Buffer.from('仅用于隔离测试'), Buffer.from([0, 1, 18, 255])];
  let page, calls = 0, dropFinish = true;
  const http = opt => opt.url.replace('https://example.invalid/v1/imports', root);
  const wx = {
    chooseMessageFile(opt) {
      assert.equal(opt.type, 'all');
      opt.success({ tempFiles: bytes.map((b, i) => ({ name: '同名.dat', size: b.length, path: String(i) })) });
    },
    async uploadFile(opt) {
      const form = new FormData();
      form.set('name', opt.formData.name); form.set(opt.name, new Blob([bytes[+opt.filePath]]), 'wx-temp');
      calls++;
      opt.success({ statusCode: (await fetch(http(opt), { method: 'POST', headers: opt.header, body: form })).status });
    },
    async request(opt) {
      const res = await fetch(http(opt), { method: opt.method, headers: opt.header, body: opt.data });
      if (dropFinish) { dropFinish = false; opt.fail(); }
      else opt.success({ statusCode: res.status });
    },
  };
  vm.runInNewContext(source, { require: () => ({ origin: 'https://example.invalid' }), wx,
    Page: p => { page = Object.assign(p, { setData(patch) { Object.assign(this.data, patch); } }); } });
  page.onLoad({ id: job.id, ticket: job.write }); page.pick();
  assert.equal(calls, 0);
  assert.deepEqual(await (await call(url, job.read)).json(), { ready: false });
  assert.equal((await call(url + '/files/0', job.read)).status, 409);
  assert.equal((await call(url, job.write)).status, 401);
  assert.equal((await call(url, other.read)).status, 401);
  await page.upload();
  assert.equal(page.data.done, false);
  await page.upload();
  assert.equal(page.data.done, true);
  assert.equal(calls, 2);
  const manifest = await (await call(url, job.read)).json();
  assert.deepEqual(manifest.files.map(f => f.name), ['同名.dat', '同名.dat']);
  for (const [i, original] of bytes.entries()) {
    assert.deepEqual(Buffer.from(await (await call(url + '/files/' + i, job.read)).arrayBuffer()), original);
  }
  assert.equal((await call(url + '/files/0', job.write, 'POST')).status, 409);
  assert.equal((await call(url, job.read, 'DELETE')).status, 200);
  assert.equal((await call(url, job.read)).status, 410);
  now += 600001;
  assert.equal((await call(root + '/' + other.id, other.read)).status, 410);
});
