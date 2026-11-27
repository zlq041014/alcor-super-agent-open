// Self-check: open every scenario, screenshot the phone, walk the key flows, and collect page errors.
// Usage: node tools/shoot.cjs [outDir] [--only a1,f5]   (needs desktop-app's playwright and local Edge)
const path = require('path');
const fs = require('fs');
const { chromium } = require(path.resolve(__dirname, '../../../desktop-app/node_modules/playwright'));

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args[onlyAt + 1].split(',') : null;
const outDir = path.resolve(args[0] && !args[0].startsWith('--') ? args[0] : path.join(root, 'evidence'));
const url = q => `file:///${path.join(root, 'index.html').replace(/\\/g, '/')}${q}`;

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1480, height: 980 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });
  const shot = async name => { await page.waitForTimeout(450); await page.locator('#device').screenshot({ path: path.join(outDir, `${name}.png`) }); console.log('shot', name); };
  const go = async (s, extra = '') => { await page.goto(url(`?s=${s}${extra}`)); await page.waitForTimeout(350); };
  const act = async sel => { await page.locator(sel).first().click(); await page.waitForTimeout(250); };
  const ev = k => act(`[data-ev="${k}"]`);
  const send = async (ms = 5000) => { await act('#app #c-send'); await page.waitForTimeout(ms); };

  await page.goto(url(''));
  const ids = await page.evaluate(() => SCENARIOS.map(s => s.id));
  for (const id of ids) {
    if (only && !only.includes(id)) continue;
    await go(id);
    await shot(id);
  }
  if (!only) {
    // layout, dark, narrow
    await go('a1'); await page.waitForTimeout(300); await page.screenshot({ path: path.join(outDir, '00-layout.png') });
    await go('a1', '&dark=1'); await shot('a1-dark');
    await go('a2', '&dark=1'); await shot('a2-dark');
    await go('c2', '&dark=1'); await shot('c2-dark');
    // flows
    await go('a1'); await send(5200); await shot('flow-a1-status');
    await go('a2'); await send(4200); await shot('flow-a2-remind');
    await go('a3'); await send(600); await shot('flow-a3-setup'); await page.fill('#key-in', 'placeholder'); await act('[data-act="saveKey"]'); await page.waitForTimeout(5200); await shot('flow-a3-after');
    await go('b1'); await act('[data-act="capSave"]'); await shot('flow-b1-saved');
    await go('c1'); await send(9500); await shot('flow-c1-research');
    await go('c2'); await send(5200); await shot('flow-c2-memask');
    await go('f1'); await send(11000); await shot('flow-f1-resume'); await act('[data-act="pickDraft"]'); await page.waitForTimeout(4200); await shot('flow-f1-decision');
    await send(3500); await shot('flow-f1-handoff');
    await go('f3'); await act('[data-arg="attachproj"]'); await shot('flow-f3-sheet'); await act('[data-act="attachTo"][data-arg="alcor-super-agent"]'); await send(3500); await act('[data-act="taskConfirm"]'); await page.waitForTimeout(1600); await shot('flow-f3-received');
    await go('f4'); await act('[data-act="taskConfirm"]'); await shot('flow-f4-local');
    await go('f5'); await ev('online'); await page.waitForTimeout(1500); await shot('flow-f5-received'); await ev('start'); await shot('flow-f5-running'); await ev('finish'); await shot('flow-f5-review');
    await act('#app .item'); await shot('flow-f5-receipt'); await act('[data-act="taskAccept"]'); await shot('flow-f5-done'); await act('[data-act="back"]'); await shot('flow-f5-home-done');
    await go('f5'); await ev('lost'); await page.waitForTimeout(1500); await shot('flow-f5-verify');
    await go('f5'); await ev('online'); await page.waitForTimeout(1500); await ev('start'); await ev('fail'); await shot('flow-f5-failed');
    await go('a4'); await act('[data-arg="press"]'); await shot('flow-a4-press'); await act('[data-arg="share"]'); await shot('flow-a4-share'); await act('[data-arg="notif"]'); await shot('flow-a4-notif');
    await go('g4'); await act('[data-act="camShot"]'); await send(4200); await shot('flow-g4-vision');
    await go('h1'); await act('[data-act="petPlay"][data-arg="handoff"]'); await shot('flow-h1-handoff');
    // board and spec
    await page.goto(url('?view=board')); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(outDir, '90-board.png'), fullPage: true });
    await page.goto(url('?view=spec')); await page.waitForTimeout(1200); await page.screenshot({ path: path.join(outDir, '91-spec.png'), fullPage: true });
    await page.setViewportSize({ width: 392, height: 852 });
    await go('a1'); await page.screenshot({ path: path.join(outDir, '92-narrow.png') });
  }
  await browser.close();
  console.log(errors.length ? `ERRORS (${errors.length}):\n${[...new Set(errors)].join('\n')}` : 'no page errors');
})().catch(e => { console.error(e); process.exit(1); });
