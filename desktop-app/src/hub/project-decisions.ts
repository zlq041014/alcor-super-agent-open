import type {
  AgentLine,
  Entity,
  Memory,
  Message,
  RuleReference,
  PreferenceReference,
  Run,
  Task,
} from "../shared/contracts";
import { redact } from "./security";
import type { Store } from "./store";
import { stamp } from "./store";
import { currentPreference } from "./preferences";

export function explicitProjectDecision(text: string) {
  const trimmed = text.trim();
  const statement = trimmed
    .replace(
      /^(?:(?:本项目规则|项目规则|项目决定|决定|确定|确认)(?:是|如下)?\s*[：:]|(?:我(?:们)?决定|决定是|本项目以后|本项目必须|要求是|定为)\s*[：:，,]?)\s*/,
      "",
    )
    .replace(/[。！!；;\s]+$/, "");
  return (
    statement !== trimmed.replace(/[。！!；;\s]+$/, "") &&
    /[\p{L}\p{N}]/u.test(statement) &&
    !/[?？]/.test(trimmed) &&
    trimmed.length <= 6000
  );
}

const statement = (text: string) => text.trim().replace(/^(?:本项目规则|项目决定|决定|记下决定)\s*[：:]\s*/, "").replace(/[。！!]$/, "").trim();
const normalizeDecision = (text: string) => text.normalize("NFKC").replace(/\s+/g, "");
export function decisionMentions(text: string, anchor: string) {
  const needle = normalizeDecision(anchor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const left = /^[A-Za-z0-9_]/.test(needle) ? "(?<![A-Za-z0-9_])" : "";
  const right = /[A-Za-z0-9_]$/.test(needle) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(left + needle + right, "i").test(normalizeDecision(text));
}

export function decisionInput(text: string): { text: string; replaces?: string } | undefined {
  const note = statement(text);
  if (note.length > 6000 || /[?？]|(?:吗|么|呢)$/.test(note)) return;
  const rewrite = /^(?:以|用)?(.+?)\s*[,，]?\s*(?:取代|替换)\s*[「“]?([^」”]{1,180})[」”]?$/.exec(note);
  if (rewrite) return { text: rewrite[1].trim(), replaces: rewrite[2].trim() };
  if (explicitProjectDecision(text) || /^(?:只用|就用|采用)\s*\S/.test(note) ||
      /^截止(?:至|到)?(?:本周|下周|周|星期)[一二三四五六日天](?:\s*(?:前|下班前|\d{1,2}[:：]\d{2}))?$/.test(note))
    return { text };
}

export const decisionHeads = (m: Memory) => m.decision?.heads ?? [m.revision];
const versionsOf = (m: Memory) => m.decision?.versions ?? [{ revision: m.revision, text: m.text, parents: [] }];
export const usableRule = (m: Memory) => m.enabled && !m.deleted && decisionHeads(m).length === 1;

export function decisionText(rule: Memory | undefined, projectId: string, revision: number) {
  return rule?.decision && !rule.deleted && rule.projectId === projectId
    ? versionsOf(rule).find(version => version.revision === revision)?.text : undefined;
}

export function reviseDecision(m: Memory, text: string, parents: number[], lineId?: string): Memory {
  const revision = m.revision + 1;
  const heads = [...decisionHeads(m).filter((head) => !parents.includes(head)), revision];
  return { ...m, revision, updatedAt: stamp(), text: heads.length === 1 ? redact(text) : m.text,
    decision: { ...m.decision!, heads,
      lineIds: lineId ? [...m.decision!.lineIds, lineId] : m.decision!.lineIds,
      versions: [...versionsOf(m), { revision, text: redact(text), parents }] } };
}

export function resolveDecision(store: Store, input: { id: string; projectId: string; revision: number; heads: number[]; selectedRevision: number }) {
  return store.tx(() => {
    const current = store.get<Memory>("memory", input.id);
    if (!current?.decision || current.deleted || current.projectId !== input.projectId)
      throw new Error("找不到此项目的待确认决定");
    const actual = decisionHeads(current);
    const seen = new Set(input.heads);
    if (current.revision !== input.revision || actual.length < 2 || seen.size !== input.heads.length ||
        seen.size !== actual.length || !actual.every(head => seen.has(head)))
      throw new Error("并列决定已变化，请重新核对后再确认");
    const versions = versionsOf(current);
    const selected = versions.find(version => version.revision === input.selectedRevision && seen.has(version.revision));
    if (!selected || !actual.every(head => versions.some(version => version.revision === head)))
      throw new Error("无法核对所选并列版本");
    const resolved = reviseDecision(current, selected.text, actual);
    resolved.decision!.versions!.at(-1)!.selectedRevision = selected.revision;
    store.put("memory", resolved);
    store.event("decision.resolved", current.id, { projectId: current.projectId, selectedRevision: selected.revision,
      parents: actual, revision: resolved.revision });
    return resolved;
  });
}

function matchingRevisions(rule: Memory, anchor: string) {
  const matching = versionsOf(rule).filter(v => decisionMentions(v.text, anchor));
  // Confirmation keeps the original text; its provenance is not a second replacement candidate.
  const copied = new Set(matching.flatMap(v => v.selectedRevision === undefined ? [] : [v.selectedRevision]));
  return matching.filter(v => !copied.has(v.revision));
}

export function replacementTargets(store: Store, projectId: string, anchor: string) {
  return store.all<Memory>("memory", projectId).filter((m) => m.decision && m.enabled && !m.deleted)
    .flatMap((rule) => matchingRevisions(rule, anchor).map(({ revision }) => ({ rule, revision })));
}

export function relevantDecisionConflicts(store: Store, projectId: string, question: string) {
  const asksChoice = /哪一?(?:版|稿)|当前决定|现行规则|(?:现在|目前)(?:要)?(?:用|选|采用)(?:哪|什么)/.test(question);
  return store.all<Memory>("memory", projectId).filter((m) => m.decision && m.enabled && !m.deleted && decisionHeads(m).length > 1)
    .map((m) => {
      const variants = versionsOf(m).filter((v) => decisionHeads(m).includes(v.revision)).map((v) => v.text);
      const replaced = versionsOf(m).filter((v) => !decisionHeads(m).includes(v.revision)).map((v) => v.text);
      return { id: m.id, variants, replaced };
    }).filter(({ variants, replaced }) => asksChoice || [...variants, ...replaced].some((text) => decisionMentions(question, statement(text))));
}

export const historicalDecisionQuestion = (text: string) => /(?:上次|当时|之前|此前|上一轮)[^。！？?]{0,12}(?:验收|验了|采用|批准)[^。！？?]{0,15}(?:什么|哪|依据[？?。！!]?$)/.test(text);

export function acceptedDecisionBasis(store: Store, tasks: Task[]) {
  const accepted = tasks.filter((t) => t.state === "done" && t.runId);
  const run = accepted.length === 1 ? store.get<Run>("run", accepted[0].runId!) : undefined;
  if (!run?.decisionInputs?.length || run.revision !== accepted[0].revision)
    return "无法核对当次验收的决定版本，请指定或打开原验收记录。";
  const values = run.decisionInputs.map(({ id, revision }) => {
    const rule = store.get<Memory>("memory", id);
    return rule?.decision && !rule.deleted ? versionsOf(rule).find((v) => v.revision === revision)?.text : undefined;
  });
  return "当次验收的决定：\n" + values.map((value) => "- " + (value ?? "原版本不可核对")).join("\n");
}

export function currentRuleReferences(
  store: Store,
  references: RuleReference[],
) {
  return references.every(({ id, revision }) => {
    const rule = store.get<Memory>("memory", id);
    return !!rule && usableRule(rule) && rule.revision === revision;
  });
}

export function currentPromptHistory<
  T extends { id: string; ruleInputs?: RuleReference[]; preferenceInput?: PreferenceReference; decisionHistory?: true;
    replyState?: string },
>(store: Store, lines: T[]): T[] {
  const rules = store.all<Memory>("memory");
  const decisionLines = new Set(
    rules.flatMap((m) => m.decision?.lineIds || []),
  );
  const versions = new Map(
    rules.filter(usableRule).map((m) => [m.id, m.revision]),
  );
  return lines.filter(
    (line) =>
      (!line.replyState || line.replyState === "complete") && !line.decisionHistory && !decisionLines.has(line.id) &&
      (!line.preferenceInput || currentPreference(store, line.preferenceInput)) &&
      (!line.ruleInputs ||
        line.ruleInputs.every(
          ({ id, revision }) => versions.get(id) === revision,
        )),
  );
}

type PreviousDecision = Entity & {
  agentId: string;
  projectId: string;
  sourceLineId: string;
  text: string;
};

// Invoked inside recovery's transaction, including after old backup restore.
export function migrateProjectDecisions(store: Store) {
  const old = store.all<PreviousDecision>("agent-decision");
  if (!old.length) return;
  const lines = store.all<AgentLine>("agent-line");
  const tombstone = store.db.prepare("SELECT 1 FROM tombstones WHERE id=?");
  for (const record of old) {
    const { agentId, sourceLineId, text, ...meta } = record;
    if (!store.get<Memory>("memory", record.id)) {
      const deleted = !!tombstone.get(record.id);
      const quote = text.split("\n用户确认：", 1)[0];
      const derived = quote !== text;
      const related = derived
        ? lines
            .filter(
              (line) =>
                line.agentId === agentId &&
                line.kind === "assistant" &&
                line.text.slice(0, 1200) === quote,
            )
            .map(({ id }) => id)
        : [];
      store.put("memory", {
        ...meta,
        text: deleted ? "" : redact(text.slice(0, 6000)),
        enabled: !deleted && !derived && explicitProjectDecision(text),
        deleted,
        source: "旧版项目讨论记录",
        decision: { agentId, lineIds: [sourceLineId, ...related] },
        revision: 1,
      } satisfies Memory);
    }
    const note = store.get<Message>("message", record.id);
    if (note?.role === "system" && note.linkAgentId === agentId)
      store.put("message", {
        ...note,
        text: "已保留项目决定记录，可在规则页核对。",
      });
    store.remove("agent-decision", record.id);
  }
}
