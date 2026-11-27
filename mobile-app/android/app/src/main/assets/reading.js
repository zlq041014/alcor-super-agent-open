import MarkdownIt from './markdown-it.js';
import { parseSlides, slidesMarkup } from './features/slides.js';

const md = new MarkdownIt({ html: false, breaks: true });
// Only the same absolute HTTPS links that the Android browser bridge can open.
md.validateLink = (href) => {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
};
const rules = md.renderer.rules;
rules.link_open = (tokens, i, options, env, renderer) => {
  tokens[i].attrSet('data-act', 'browse');
  tokens[i].attrSet('data-v', tokens[i].attrGet('href'));
  return renderer.renderToken(tokens, i, options);
};
rules.image = (tokens, i, options, env, renderer) =>
  md.utils.escapeHtml(renderer.renderInlineAsText(tokens[i].children, options, env));
rules.table_open = () => '<div class="reading-table"><table>';
rules.table_close = () => '</table></div>';
const ordinaryFence = rules.fence;
rules.fence = (tokens, i, options, env, renderer) => {
  if (env.artifacts && tokens[i].info.trim().toLowerCase() === 'alcor-slides') {
    try { return slidesMarkup(parseSlides(tokens[i].content)); }
    catch (error) { return `<div class="slides-error"><b>PPT 大纲无法读取</b><span>${md.utils.escapeHtml(error.message)}</span><pre>${md.utils.escapeHtml(tokens[i].content)}</pre></div>`; }
  }
  if (!env.artifacts || tokens[i].info.trim().toLowerCase() !== 'mermaid')
    return ordinaryFence(tokens, i, options, env, renderer);
  return diagramMarkup(tokens[i].content);
};

export function diagramMarkup(source, enlarged = false, zoom = 1) {
  return `<figure class="diagram-preview" data-diagram>
    <p data-diagram-status role="status">正在排版</p>
    ${enlarged ? `<div class="diagram-scroll"><div data-diagram-image data-zoom="${zoom}"></div></div>` :
      '<button type="button" aria-label="放大查看架构图" class="diagram-open" data-act="diagram-open" data-diagram-image></button>'}
    <details><summary>Mermaid 源码</summary><pre><code data-diagram-source>${md.utils.escapeHtml(source)}</code></pre>
      ${enlarged ? '' : '<button type="button" class="btn text" data-act="diagram-copy">复制源码</button>'}</details>
  </figure>`;
}

// Only split long, unmarked prose at sentence endings. Lists, quotations,
// code and inline markup keep the structure supplied by their author.
export function reading(source, artifacts = false) {
  const tokens = md.parse(source, {});
  const spaced = tokens.flatMap((token, i) => {
    const open = tokens[i - 1], close = tokens[i + 1];
    if (open?.type !== 'paragraph_open' || open.level !== 0 || token.type !== 'inline' ||
        token.children.length !== 1 || token.children[0].type !== 'text' || token.content.length < 180) return [token];
    const child = token.children[0];
    const sentences = child.content.match(/[^。！？]+(?:[。！？]+[」』”’）]*)?|[。！？]+/gu) ?? [];
    const paragraphs = [''];
    for (const sentence of sentences) {
      if (paragraphs.at(-1).length >= 90) paragraphs.push('');
      paragraphs[paragraphs.length - 1] += sentence;
    }
    return paragraphs.flatMap((content, j) => [
      ...(j ? [close, open] : []), { ...token, children: [{ ...child, content }] },
    ]);
  });
  return md.renderer.render(spaced, md.options, { artifacts });
}
