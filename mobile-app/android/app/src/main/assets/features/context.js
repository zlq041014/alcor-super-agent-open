// Budget and summary helpers for the chat context. Pure functions so the release UI does not depend on a tokenizer.
export const DEFAULT_CONTEXT_TOKENS = 80000;
export const DEFAULT_CHARS_PER_TOKEN = 1.6;
const MESSAGE_OVERHEAD = 12;

export function activeSummary(d) {
  const all = d.summaries ?? [];
  return all.reduce((best, item) => !best || (item.version ?? 0) > (best.version ?? 0) ? item : best, null);
}

export function summaryEnd(d, summary = activeSummary(d)) {
  if (!summary) return -1;
  return d.messages.findIndex((m) => m.id === summary.to);
}

/** IDs of the messages already represented by the latest summary. */
export function coveredIds(d, summary = activeSummary(d)) {
  const end = summaryEnd(d, summary);
  return end < 0 ? new Set() : new Set(d.messages.slice(0, end + 1).map((m) => m.id));
}

export function coveredMessages(d, summary = activeSummary(d)) {
  const end = summaryEnd(d, summary);
  return end < 0 ? [] : d.messages.slice(0, end + 1);
}

export function messageChars(message) {
  return MESSAGE_OVERHEAD + String(message?.text ?? '').length + String(message?.reasoning ?? '').length;
}

export function totalChars(messages) {
  return messages.reduce((sum, message) => sum + messageChars(message), 0);
}

/** Keeps the newest suffix that fits; the caller decides whether the omitted prefix needs a summary. */
export function fitHistory(messages, budgetChars) {
  const kept = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = messageChars(messages[i]);
    if (kept.length >= 2 && chars + size > budgetChars) break;
    kept.unshift(messages[i]);
    chars += size;
  }
  return { kept, omitted: messages.slice(0, messages.length - kept.length), chars };
}

/** Splits around a target suffix size, keeping at least two messages for continuity. */
export function splitRecent(messages, keepChars) {
  const kept = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const size = messageChars(messages[i]);
    if (kept.length >= 2 && chars + size > keepChars) break;
    kept.unshift(messages[i]);
    chars += size;
  }
  return { kept, omitted: messages.slice(0, messages.length - kept.length), chars };
}

export function summaryPrompt(prior, messages) {
  const flatten = messages.filter((m) => m.text?.trim()).map((m) =>
    (m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : '记录') + '：' + m.text.trim().slice(0, 4000)).join('\n\n');
  const transcript = flatten.length > 120000 ? flatten.slice(0, 60000) + '\n…（中间省略）…\n' + flatten.slice(-60000) : flatten;
  return [
    { role: 'system', content: '你是星引的手机对话摘要器。只输出前情摘要，不回答对话。保留已定的决定及其版本、用户明确要求的原话、未解决的问题和用过的材料清单；不要编造，不要添加原对话没有的内容。' },
    { role: 'user', content: (prior?.text ? '已有摘要：\n' + prior.text.slice(0, 6000) + '\n\n' : '') + '需要压缩的记录：\n' + transcript },
  ];
}

export function summaryCardText(summary) {
  return '前情摘要 · 第 1–' + summary.count + ' 条 · 第 ' + summary.version + ' 版';
}
