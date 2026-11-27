const NS = 'http://www.w3.org/2000/svg';
const cache = new Map(), mounted = new WeakSet();
let library, serial = 0;

function renderer() {
  library ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'features/vendor/mermaid.js';
    script.onload = () => {
      const engine = window.mermaid;
      if (!engine) { reject(new Error('架构图组件无法加载')); return; }
      engine.initialize({
        startOnLoad: false, securityLevel: 'strict', htmlLabels: false,
        flowchart: { htmlLabels: false }, maxTextSize: 16000, maxEdges: 200,
        suppressErrorRendering: true, fontFamily: 'sans-serif', theme: 'neutral',
      });
      resolve(engine);
    };
    script.onerror = () => reject(new Error('架构图组件无法加载'));
    document.head.append(script);
  });
  return library;
}

function sourceForRendering(source) {
  if (source.length > 16000) throw new Error('图表源码超过 16,000 字符');
  if (source.includes('%%{') || /^\s*---\s*$/m.test(source) || /<(?:\/?[a-z]|[!?])/i.test(source))
    throw new Error('图表不支持自定义配置或 HTML 标签');
  const first = source.split(/\r?\n/).map(l => l.trim()).find(l => l && !l.startsWith('%%')) ?? '';
  if (!/^(?:flowchart|graph|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?)(?:\s|$)/.test(first))
    throw new Error('支持 Mermaid 流程图、时序图、类图和状态图');
  return source;
}

function offlineSvg(markup) {
  const root = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  const nodes = [...root.querySelectorAll('*')];
  if (root.namespaceURI !== NS || root.localName !== 'svg' || nodes.length > 18000) throw new Error('图表输出无效或过大');
  const blocked = new Set(['foreignObject', 'script', 'image', 'iframe', 'object', 'embed', 'a', 'animate', 'animateMotion', 'animateTransform', 'set']);
  const localUrl = /^#[a-zA-Z0-9_.:-]+$/;
  function checkCss(value) {
    if (/@import/i.test(value)) throw new Error('图表不能加载外部资源');
    for (const ref of value.matchAll(/url\(\s*([^)]*)\)/gi))
      if (!localUrl.test(ref[1].trim().replace(/^['"]|['"]$/g, ''))) throw new Error('图表不能加载外部资源');
  }
  for (const element of [root, ...nodes]) {
    if (element.namespaceURI !== NS || blocked.has(element.localName)) throw new Error('图表不能嵌入媒体、链接或 HTML');
    for (const attr of element.attributes) {
      if (/^on/i.test(attr.localName) || (attr.localName === 'href' && !localUrl.test(attr.value)))
        throw new Error('图表不能执行动作或加载外部资源');
      checkCss(attr.value);
    }
    if (element.localName === 'style') checkCss(element.textContent);
  }
  const [x, y, width, height] = (root.getAttribute('viewBox') ?? '').trim().split(/[ ,]+/).map(Number);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('无法确定图表尺寸');
  // Mermaid often uses percentage widths. An intrinsic size prevents cropping on export.
  root.setAttribute('width', String(width)); root.setAttribute('height', String(height));
  return { width, height, blob: new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }) };
}

function diagram(source) {
  if (cache.has(source)) return cache.get(source);
  const result = Promise.resolve().then(async () => {
    const input = sourceForRendering(source);
    const api = await renderer();
    const { svg } = await api.render('alcor-diagram-' + ++serial, input);
    return offlineSvg(svg);
  });
  cache.set(source, result);
  if (cache.size > 16) cache.delete(cache.keys().next().value);
  return result;
}

function imageFor(target, artifact) {
  const image = new Image();
  const url = URL.createObjectURL(artifact.blob);
  image.alt = 'Mermaid 架构图';
  image.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  image.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
  image.src = url;
  target.replaceChildren(image);
}

export function mountDiagrams(root) {
  for (const card of root.querySelectorAll('[data-diagram]')) {
    if (mounted.has(card)) continue;
    mounted.add(card);
    const source = card.querySelector('[data-diagram-source]').textContent;
    const status = card.querySelector('[data-diagram-status]');
    void diagram(source).then((artifact) => {
      if (!card.isConnected) return;
      const target = card.querySelector('[data-diagram-image]');
      if (target.dataset.zoom) target.style.width = Number(target.dataset.zoom) * 100 + '%';
      imageFor(target, artifact);
      status.hidden = true;
      card.dataset.diagramState = 'ready';
    }, (error) => {
      if (!card.isConnected) return;
      card.dataset.diagramState = 'failed';
      status.textContent = '无法画出这张图：' + String(error.message || error.str || '请检查源码').slice(0, 300);
      card.querySelector('details').open = true;
    });
  }
}

export async function diagramPng(source) {
  const { blob, width, height } = await diagram(source);
  const scale = Math.min(2, 1600 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width * scale)); canvas.height = Math.max(1, Math.ceil(height * scale));
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').slice('data:image/png;base64,'.length);
  } finally { URL.revokeObjectURL(url); }
}
