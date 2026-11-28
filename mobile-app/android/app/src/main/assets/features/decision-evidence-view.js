import { esc } from '../icons.js';

const labels = {
  unverified: '这版没有可核实的原话引用。', missing: '找不到这条决定或无权查看。',
  stale: '这版已不是当前决定，请刷新项目。', conflict: '有并列版本，请回原讨论核对。',
};
const time = at => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function decisionEvidenceView({ result, discussion }) {
  const verified = result.state === 'verified';
  const source = verified ? `<pre class="diff">${esc(result.quote)}</pre>` : `<p class="lead">${esc(labels[result.state])}</p>`;
  const times = [result.sourceAt ? '原话时间：' + time(result.sourceAt) : '原话时间未核实',
    result.receivedAt ? '电脑收悉：' + time(result.receivedAt) : '电脑收悉时间未核实', '生效时间未单独记录'];
  return source + `<p class="foot-note">${times.map(esc).join(' · ')}</p>` +
    `<div class="row-btns"><button type="button" class="btn ghost" data-act="resume-open-source" data-v="${esc(JSON.stringify([discussion, result.messageId]))}">打开原讨论</button></div>`;
}
