import type { AgentLine } from "../shared/contracts";
import type { Store } from "./store";

export type DecisionSource = { messageId: string; start: number; end: number };
type Version = { version: string; quote: string; at: string; source?: DecisionSource };
type Decision = { discussion: string; heads: string[]; versions: Version[] };

export function decisionQuote(store: Store, discussion: string, source: DecisionSource, quote: string) {
  const message = store.get<AgentLine>("agent-line", source.messageId);
  if (!message || message.agentId !== discussion || message.kind !== "user" || message.status === "failed" ||
      !quote || source.start < 0 || source.end <= source.start || source.end > message.text.length ||
      message.text.slice(source.start, source.end) !== quote) return undefined;
  if ([source.start, source.end].some(at => /[\uD800-\uDBFF]/.test(message.text.charAt(at - 1)) &&
      /[\uDC00-\uDFFF]/.test(message.text.charAt(at)))) return undefined;
  return { quote, messageId: message.id, ...(Number.isFinite(Date.parse(message.createdAt)) ? { sourceAt: message.createdAt } : {}) };
}

export function readMobileDecisionEvidence(store: Store, discussion: string, id: string, version: string) {
  const record = store.get<Decision>("mobile-decision", id);
  if (!record || record.discussion !== discussion) return { state: "missing" };
  const basis = record.versions.find(row => row.version === version);
  if (!basis) return { state: "missing" };
  if (record.heads.length !== 1) return { state: "conflict" };
  if (record.heads[0] !== version) return { state: "stale" };
  const at = Number.isFinite(Date.parse(basis.at)) ? { receivedAt: basis.at } : {};
  const source = basis.source && decisionQuote(store, record.discussion, basis.source, basis.quote);
  return source ? { state: "verified", ...at, ...source } : { state: "unverified", ...at };
}
