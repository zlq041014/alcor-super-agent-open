const NOTICE_STAGES = new Set(['review', 'failed', 'done']);

export function recordWorkNotice(work, receipt, seq, at) {
  const question = receipt.stage === 'waiting' && receipt.question;
  const type = question ? 'question' : NOTICE_STAGES.has(receipt.stage) ? receipt.stage : '';
  if (!type) {
    delete work.notice;
    return;
  }
  // Material or history updates may emit another receipt for the same phase without opening a new action.
  const turn = typeof receipt.turnId === 'string' ? receipt.turnId : '';
  const key = question ? 'question:' + question.id : type + ':' + turn;
  if (work.notice?.key === key) return;
  const seen = work.noticeKeys ??= [];
  if (!question && work.notice?.type === type && (!turn || !work.notice.turn)) {
    if (turn) {
      work.notice.turn = turn;
      work.notice.key = key;
      if (!seen.includes(key)) seen.push(key);
    }
    return;
  }
  if (seen.includes(key)) {
    delete work.notice;
    return;
  }
  seen.push(key);
  work.notice = { key, seq, at, type, turn, unread: true };
}

export function unreadWork(work, now = Date.now()) {
  return !!work.notice?.unread && (work.notice.type !== 'question' || Date.parse(work.receipt?.question?.expiresAt) > now);
}

export const pendingWork = (work) => unreadWork(work) || !['draft', 'cancelled', 'done'].includes(work.stage);
