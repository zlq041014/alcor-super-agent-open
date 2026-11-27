// 原型自检截图：走一遍各场景的关键交互，截手机画面并收集页面报错。
// 用法：node tools/shoot.cjs [输出目录]（需要 desktop-app 的 playwright 依赖与本机 Edge）
const path = require('path');
const { chromium } = require(path.resolve(__dirname, '../../../desktop-app/node_modules/playwright'));

const root = path.resolve(__dirname, '..');
const outDir = path.resolve(process.argv[2] || path.join(root, 'evidence'));
const url = s => `file:///${path.join(root, 'index.html').replace(/\\/g, '/')}?s=${s}`;

(async () => {
  require('fs').mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: 'msedge' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = async name => { await page.waitForTimeout(350); await page.locator('#device').screenshot({ path: path.join(outDir, `${name}.png`) }); console.log('shot', name); };
  const go = async s => { await page.goto(url(s)); await page.waitForTimeout(300); };
  const act = sel => page.locator(sel).first().click();
  const sendAndWait = async (ms = 4500) => { await act('#device [data-act="send"]'); await page.waitForTimeout(ms); };
  const ev = k => act(`[data-ev="${k}"]`);

  await go('s1'); await page.screenshot({ path: path.join(outDir, '00-layout.png') }); await shot('01-home');
  await act('[data-v="question"]'); await shot('01b-question');

  await go('s2'); await shot('02-setup-home'); await sendAndWait(300); await page.fill('#key-input', 'placeholder'); await shot('02b-setup-sheet');
  await act('#setup-save'); await page.waitForTimeout(4500); await shot('02c-after-setup');

  await go('s3'); await shot('03-resume-input'); await sendAndWait(6500); await shot('03b-resume-disc');
  await act('[data-act="pick"]'); await shot('03c-decision');
  await act('[data-act="go"][data-v="home"]'); await shot('03d-home-after');

  await go('s4'); await sendAndWait(); await shot('04-ambiguous');

  await go('s5'); await sendAndWait(5000); await shot('05-search');

  await go('s6'); await sendAndWait(); await shot('06-handoff-draft');
  await act('#device [data-act="sheet"][data-v="target"]'); await shot('06b-target'); await page.keyboard.press('Escape');
  await act('[data-act="confirm"]'); await shot('06c-local');

  await go('s7'); await shot('07-local');
  await ev('online'); await page.waitForTimeout(1400); await shot('07b-queued');
  await ev('start'); await shot('07c-running');
  await ev('finish'); await shot('07d-review');
  await act('[data-act="task"]'); await shot('07e-receipts'); await page.keyboard.press('Escape');
  await act('[data-act="go"][data-v="home"]'); await shot('07f-home');
  await page.check('#ctl-dark'); await shot('07g-home-dark'); await page.uncheck('#ctl-dark');
  await go('s7'); await ev('onlineLost'); await page.waitForTimeout(1400); await shot('07h-verify');
  await go('s7'); await ev('online'); await page.waitForTimeout(1400); await ev('start'); await ev('fail'); await shot('07i-failed');

  await go('s8'); await shot('08-sessions-project');
  await act('[data-act="tab"][data-v="recent"]'); await shot('08b-recent');
  await act('[data-act="tab"][data-v="kind"]'); await shot('08c-kind');

  await go('s9'); await sendAndWait(800); await shot('09-offline');

  await go('s10'); await act('[data-v="conflict"]'); await shot('10-conflict');

  await page.setViewportSize({ width: 390, height: 844 });
  await go('s1'); await page.screenshot({ path: path.join(outDir, '11-mobile-viewport.png') });

  await browser.close();
  console.log(errors.length ? `ERRORS:\n${errors.join('\n')}` : 'no page errors');
})().catch(e => { console.error(e); process.exit(1); });
