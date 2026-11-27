/* 成果：架构图预览、PPT 大纲与按页预览、相册整理、拍照即问。 */
'use strict';

/* ================= 架构图 ================= */
const DIAGRAM_SRC = `flowchart LR
  P[手机 · 星引] -->|直连 · 优先| H[电脑 Hub]
  P -.->|只转发密文| R((你的云主机))
  R -.-> H
  P --> M[DeepSeek API]
  P --- D[(本机数据库)]
  H --> C[Codex]
  H --> S[DSH]`;
function diagramSVG() {
  const node = (x, y, w, h, label, sub, cls = '') => `<g class="dn ${cls}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/><text x="${x + w / 2}" y="${y + (sub ? h / 2 - 3 : h / 2 + 4)}">${label}</text>${sub ? `<text class="s" x="${x + w / 2}" y="${y + h / 2 + 11}">${sub}</text>` : ''}</g>`;
  return `<svg class="diagram-svg" viewBox="0 0 344 250" role="img" aria-label="手机、中继与电脑的连接关系">
    <defs><marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z"/></marker></defs>
    <path class="de" d="M98 117H244" marker-end="url(#ar)"/><text class="dl" x="171" y="110">直连 · 优先</text>
    <path class="de dash" d="M72 95C80 62 104 52 128 50" marker-end="url(#ar)"/><path class="de dash" d="M216 50C244 52 268 64 280 93" marker-end="url(#ar)"/><text class="dl" x="172" y="84">只转发密文</text>
    <path class="de" d="M46 95V54" marker-end="url(#ar)"/><path class="de" d="M46 139V186"/>
    <path class="de" d="M270 139 240 186" marker-end="url(#ar)"/><path class="de" d="M300 139 310 186" marker-end="url(#ar)"/>
    ${node(8, 14, 90, 38, 'DeepSeek API', '', 'ext')}${node(8, 95, 90, 44, '手机', '星引', 'main')}${node(8, 188, 90, 40, '本机数据库', '笔记 · 记忆', 'ext')}
    ${node(130, 30, 84, 40, '你的云主机', '中继', 'relay')}${node(246, 95, 90, 44, '电脑', 'Hub', 'main')}
    ${node(206, 188, 62, 38, 'Codex', '', 'ext')}${node(280, 188, 56, 38, 'DSH', '', 'ext')}</svg>`;
}
CARDS.diagram = m => m.error
  ? `<div class="card"><div class="card-h">${tile('warn', 'amber')}<div class="t"><b>这张图没画出来</b><small>第 4 行：箭头后面缺少节点</small></div></div>
      <pre class="diff">${esc(DIAGRAM_SRC.split('\n').slice(0, 3).join('\n'))}\n  P --> </pre>
      <div class="btns"><button class="btn soft sm" data-act="fill" data-arg="图的第 4 行少了节点，改一下">让小引改</button><button class="ibtn sm" data-act="toast" data-arg="已复制图的源码" aria-label="复制源码">${ic('copy', 'sm')}</button></div></div>`
  : `<div class="card"><div class="card-h">${em('diagram', 40)}<div class="t"><b>手机、中继与电脑</b></div><button class="ibtn sm" data-act="toast" data-arg="原型：导出为图片，保存或分享" aria-label="导出图片">${ic('export', 'sm')}</button><button class="ibtn sm" data-act="toast" data-arg="已复制图的源码" aria-label="复制源码">${ic('copy', 'sm')}</button></div>
      <button class="diagram" data-act="sheet" data-arg="diagram" aria-label="放大查看">${diagramSVG()}</button></div>`;
SHEETS.diagram = () => sheet('手机、中继与电脑', `<div class="btns"><button class="btn ghost" data-act="diagramScale" data-arg="-1">缩小</button>
  <button class="btn ghost" data-act="diagramScale" data-arg="1">放大</button></div>
  <div class="card diagram big" style="overflow:auto"><div style="width:${100 + 40 * (S.flags.diagramScale || 0)}%">${diagramSVG()}</div></div>
  <div class="card"><div class="n-label">${ic('text', 'xs')}Mermaid 源码</div><pre class="diff">${esc(DIAGRAM_SRC)}</pre></div>`,
{ full: true, foot: `<button class="btn ghost grow" data-act="toast" data-arg="已复制图的源码">${ic('copy', 'sm')}复制源码</button><button class="btn pri grow" data-act="toast" data-arg="原型：导出整张 PNG">${ic('image', 'sm')}导出 PNG</button>` });
ACT.diagramScale = step => { S.flags.diagramScale = Math.max(0, Math.min(3, (S.flags.diagramScale || 0) + Number(step))); render(); };

/* ================= PPT ================= */
const SLIDES = [
  { t: '跨网络送达', pts: ['出门也能把事交给电脑', '手机自动选更快的路线'], kind: 'cover' },
  { t: '要解决的问题', pts: ['离开局域网收不到回执', '第三方隧道慢：300–800 ms', '大流量会挤占云主机出口'] },
  { t: '三条路线', pts: ['直连：可达就用', '自有中继：直连不通时', '第三方隧道：没有中继时'] },
  { t: '云主机只搬运密文', pts: ['加密在手机和电脑之间完成', '电脑主动连出去，不开入站端口', '云主机不代存请求'] },
  { t: '换路线不会重复执行', pts: ['同一台电脑、同一个证书指纹', '请求带稳定编号，电脑去重'] },
  { t: '分两步做', pts: ['先用反向隧道验证', '对外提供时再换成纯转发中继'] },
];
const slideHTML = (s, i, big) => `<div class="slide ${s.kind || ''} ${big ? 'big' : ''}"><small>${i + 1} / ${SLIDES.length}</small><b>${esc(s.t)}</b><ul>${s.pts.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
CARDS.slides = () => `<div class="card"><div class="card-h">${em('slides', 40)}<div class="t"><b>跨网络送达</b><small>${SLIDES.length} 页</small></div><button class="ibtn sm" data-act="sheet" data-arg="slide:0" aria-label="逐页预览">${ic('right', 'sm')}</button></div>
  <div class="slides">${SLIDES.map((s, i) => `<button data-act="sheet" data-arg="slide:${i}">${slideHTML(s, i)}</button>`).join('')}</div></div>`;
SHEETS.slide = ({ id }) => {
  const i = +id, s = SLIDES[i];
  return sheet(`第 ${i + 1} 页`, `${slideHTML(s, i, true)}
    <div class="card"><div class="n-label">${ic('text', 'xs')}讲稿要点</div><div class="md"><p>${i === 0 ? '开场一句话：出门在外，也能把明确的工作交给家里或公司的电脑，并且收到真实的回执。' : `这一页讲「${esc(s.t)}」。先说结论，再用上面几条要点展开。`}</p></div></div>`,
  { sub: esc(s.t), foot: `<button class="btn ghost grow" data-act="sheet" data-arg="slide:${Math.max(0, i - 1)}" ${i === 0 ? 'disabled' : ''}>${ic('back', 'sm')}上一页</button><button class="btn ghost grow" data-act="sheet" data-arg="slide:${Math.min(SLIDES.length - 1, i + 1)}" ${i === SLIDES.length - 1 ? 'disabled' : ''}>下一页${ic('right', 'sm')}</button>
  <button class="btn pri grow" data-act="toast" data-arg="原型：导出全部页的 Markdown">导出 Markdown</button>` });
};

/* ================= 相册整理 ================= */
const PHOTO_TONES = ['#d9c7a8', '#a8c3d9', '#c9d9a8', '#d9a8b6', '#b6a8d9', '#a8d9cf', '#d9b8a8', '#a8b0d9'];
const photoHTML = (i, mark = '') => `<span class="ph" style="background:${PHOTO_TONES[i % PHOTO_TONES.length]}">${ic('image', 'sm')}${mark ? `<i class="${mark}">${{ dup: '重复', blur: '模糊' }[mark]}</i>` : ''}</span>`;
SCREENS.albumpick = () => {
  const n = S.flags.albumN == null ? 24 : S.flags.albumN;
  return page({
    title: '选择照片', left: 'close', sub: '只授权你选的这几张',
    right: `<button class="btn pri sm" data-act="albumSend" ${n ? '' : 'disabled'}>选好了（${n}）</button>`,
    body: `<div class="ph-grid pick">${Array.from({ length: 30 }, (_, i) => `<button class="${i < n ? 'on' : ''}" data-act="albumN" data-arg="${i < n ? i : i + 1}">${photoHTML(i)}${i < n ? `<em>${ic('check', 'xs')}</em>` : ''}</button>`).join('')}</div>
      `,
  });
};
ACT.albumN = v => { S.flags.albumN = +v; render(); };
ACT.albumSend = () => {
  const n = S.flags.albumN == null ? 24 : S.flags.albumN, cid = S.flags.albumConv;
  S.stack.pop();
  pushMsg(cid, { kind: 'albumask', n });
  S.enter = 'enter-back'; render();
};
CARDS.albumask = m => (m.state === 'sent' ? `<div class="sysline">${m.n} 张照片已发给模型</div>` : m.state === 'no' ? '<div class="sysline">没有发送照片</div>'
  : `<div class="card"><div class="card-h">${em('album', 40)}<div class="t"><b>把这 ${m.n} 张发给模型？</b></div></div>
      <div class="ph-grid mini">${Array.from({ length: 6 }, (_, i) => photoHTML(i)).join('')}<span class="ph more">+${m.n - 6}</span></div>
      ${box(`<b>${m.n} 张 · 预计 ≈¥${(m.n * 0.008).toFixed(2)}</b>`, 'amber', 'export')}
      <div class="btns"><button class="btn pri grow" data-act="albumGo" data-arg="${m.id}">发送</button><button class="btn ghost" data-act="albumNo" data-arg="${m.id}">不发</button></div></div>`);
ACT.albumNo = mid => { const [m] = findMsg(mid); m.state = 'no'; render(); };
ACT.albumGo = async mid => {
  const [m, c] = findMsg(mid);
  m.state = 'sent'; render();
  await aiTurn(c.id, { text: `看完了这 ${m.n} 张。主要是上周末的崇明和两次聚餐，有几组连拍和几张糊掉的。建议在下面，**你点了确认才会动照片**：`, usage: { hit: 2400, miss: 21600, out: 310, think: 540 } });
  pushMsg(c.id, { kind: 'album', n: m.n });
  render();
};
CARDS.album = m => {
  if (m.state === 'done') return `<div class="savedline">${ic('check', 'xs')}<span>已建 2 个相册，移走 4 张</span></div>`;
  const g = (title, sub, cells, key) => `<div class="al-g"><div class="al-h"><span><b>${title}</b><small>${sub}</small></span>${tg(!m.off || !m.off[key], 'albumFlip', `${m.id}|${key}`, title)}</div><div class="ph-grid mini">${cells}</div></div>`;
  return `<div class="card"><div class="card-h">${em('album', 40)}<div class="t"><b>整理建议</b></div></div>
    ${g('重复 · 7 张', '留 3 张，移走 4 张', [0, 0, 0, 3, 3, 5, 5].map((t, i) => photoHTML(t, i % 3 ? 'dup' : '')).join(''), 'dup')}
    ${g('模糊 · 4 张', '只标出来', [1, 2, 6, 7].map(t => photoHTML(t, 'blur')).join(''), 'blur')}
    ${g('建 2 个相册', '崇明 12 张 · 聚餐 6 张', [2, 4, 6, 1, 3].map(t => photoHTML(t)).join(''), 'albums')}
    <div class="btns"><button class="btn pri grow" data-act="albumApply" data-arg="${m.id}">按勾选的整理</button><button class="btn ghost" data-act="toast" data-arg="好，照片都没有动">不动</button></div></div>`;
};
ACT.albumFlip = arg => { const [mid, k] = arg.split('|'), [m] = findMsg(mid); m.off = m.off || {}; m.off[k] = !m.off[k]; render(); };
ACT.albumApply = mid => openSheet('albumok', { id: mid });
SHEETS.albumok = ({ id }) => sheet('允许星引移走 4 张照片吗？', `<div class="ph-grid mini">${[0, 0, 3, 5].map(t => photoHTML(t, 'dup')).join('')}</div>
  <div class="hint" style="font-size:13.5px">移走的照片 30 天内可以恢复。</div>`,
{ sub: '系统确认', foot: `<button class="btn ghost grow" data-act="closeSheet">不允许</button><button class="btn pri grow" data-act="albumDone" data-arg="${id}">允许</button>` });
ACT.albumDone = mid => { const [m] = findMsg(mid); m.state = 'done'; S.sheet = null; render(); toast('整理好了'); };

/* ================= 拍照即问 ================= */
SCREENS.camera = () => `<div class="page camera"><div class="cam-view"><div class="cam-frame"></div><span>${ic('image', 'lg')}取景画面（示意）</span></div>
  <div class="cam-bar"><button class="ib" data-act="back" aria-label="关闭">${ic('x')}</button><button class="shutter" data-act="camShot" aria-label="拍照"></button><button class="ib" data-act="toast" data-arg="原型：改从相册选" aria-label="相册">${ic('image')}</button></div>
  <div class="cam-hint">照片只进入这一轮。</div></div>`;
ACT.camShot = () => {
  S.stack.pop();
  let key = curConvId();
  if (!key) { S.stack = [{ n: 'home' }]; key = homeId(); }
  (S.mats[key] = S.mats[key] || []).push({ icon: 'image', label: '刚拍的照片' });
  if (!S.input[key]) S.input[key] = S.flags.camAsk || '这是什么？';
  if (S.set.model === 'pro') toast('V4 Pro 不接收图片。发送前请换成 V4.1 Flash');
  S.enter = 'enter-back'; render();
};
