import { A, esc, ic } from '../icons.js';

export const SLIDES_PROMPT = '生成 PPT 或幻灯片大纲时，用一个 alcor-slides 代码块输出有效 JSON：' +
  '{"title":"总标题","slides":[{"title":"页标题","points":["要点"],"notes":"可选讲稿"}]}。' +
  '按用户要求排页，1 至 40 页，每页最多 8 个要点，标题、要点和讲稿使用纯文本。';

const clean = (value, max) => {
  if (typeof value !== 'string') throw new Error('大纲文字必须是字符串');
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u001f]/.test(result)) throw new Error('大纲文字无效');
  return result;
};
export function parseSlides(source) {
  if (source.length > 32000) throw new Error('PPT 大纲超过 32,000 字符');
  let value;
  try { value = JSON.parse(source); } catch { throw new Error('PPT 大纲不是有效 JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.slides) ||
      value.slides.length < 1 || value.slides.length > 40) throw new Error('PPT 大纲需要 1 至 40 页');
  const title = clean(value.title, 160);
  const slides = value.slides.map((slide, index) => {
    if (!slide || typeof slide !== 'object' || !Array.isArray(slide.points) || slide.points.length > 8)
      throw new Error(`第 ${index + 1} 页要点无效`);
    return { title: clean(slide.title, 160), points: slide.points.map((point) => clean(point, 400)),
      notes: slide.notes == null || slide.notes === '' ? '' : clean(slide.notes, 3000) };
  });
  return { title, slides };
}
export function slideMarkdown(deck) {
  const literal = (s) => s.replace(/[\\`*_{}\[\]()<>#+\-!.|&~]/g, '\\$&');
  return '# ' + literal(deck.title) + '\n\n' + deck.slides.map((slide, i) =>
    `## ${i + 1}. ${literal(slide.title)}` +
    (slide.points.length ? '\n\n' + slide.points.map((p) => '- ' + literal(p)).join('\n') : '') +
    (slide.notes ? '\n\n> 讲稿：' + literal(slide.notes) : '')).join('\n\n') + '\n';
}
const card = (slide, index, total, small = true) => `<article class="slide-card${small ? '' : ' large'}${index === 0 ? ' cover' : ''}">
  <small>${index + 1} / ${total}</small><h3>${esc(slide.title)}</h3>
  <ul>${slide.points.map((point) => `<li>${esc(point)}</li>`).join('')}</ul>
  ${!small && slide.notes ? `<details><summary>讲稿要点</summary><p>${esc(slide.notes)}</p></details>` : ''}
</article>`;
export function slidesMarkup(deck) {
  return `<section class="slides-preview" data-slides data-slides-json="${esc(JSON.stringify(deck))}">
    <header><img src="${A('slides')}" alt=""><div><b>${esc(deck.title)}</b><small>${deck.slides.length} 页</small></div>
    <button type="button" class="btn text" data-act="slides-export">导出 Markdown</button></header>
    <div class="slides-strip">${deck.slides.map((slide, i) => `<button type="button" class="slide-thumb" data-act="slides-open" data-v="${i}"
      aria-label="第 ${i + 1} 页：${esc(slide.title)}">${card(slide, i, deck.slides.length)}</button>`).join('')}</div>
  </section>`;
}
export function slidesSheet(deck, index = 0) {
  const i = Math.max(0, Math.min(deck.slides.length - 1, index)), slide = deck.slides[i];
  return { title: deck.title, body: card(slide, i, deck.slides.length, false) +
    `<div class="row-btns"><button class="btn ghost grow" data-act="slides-page" data-v="${i - 1}" ${i === 0 ? 'disabled' : ''}>${ic('back','sm')}上一页</button>
    <span class="slide-counter">${i + 1} / ${deck.slides.length}</span>
    <button class="btn ghost grow" data-act="slides-page" data-v="${i + 1}" ${i === deck.slides.length - 1 ? 'disabled' : ''}>下一页${ic('right','sm')}</button></div>
    <div class="row-btns"><button class="btn primary grow" data-act="slides-export">导出 Markdown</button></div>` };
}
