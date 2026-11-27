import type {
  AgentLine,
  Entity,
  Memory,
  Message,
  RuleReference,
  PreferenceReference,
} from "../shared/contracts";
import { redact } from "./security";
import type { Store } from "./store";
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

export function currentRuleReferences(
  store: Store,
  references: RuleReference[],
) {
  return references.every(({ id, revision }) => {
    const rule = store.get<Memory>("memory", id);
    return rule?.enabled && !rule.deleted && rule.revision === revision;
  });
}

export function currentPromptHistory<
  T extends { id: string; ruleInputs?: RuleReference[]; preferenceInput?: PreferenceReference },
>(store: Store, lines: T[]): T[] {
  const rules = store.all<Memory>("memory");
  const decisionLines = new Set(
    rules.flatMap((m) => m.decision?.lineIds || []),
  );
  const versions = new Map(
    rules.filter((m) => m.enabled && !m.deleted).map((m) => [m.id, m.revision]),
  );
  return lines.filter(
    (line) =>
      !decisionLines.has(line.id) &&
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
