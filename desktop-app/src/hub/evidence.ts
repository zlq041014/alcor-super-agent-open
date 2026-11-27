import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Project, Run, Task } from "../shared/contracts";
import type { CheckRun, Criterion, Loop } from "../shared/loop-contracts";
import { userRequest } from "./contracting";
import { hash, redact, within } from "./security";
import type { RoleMaterial } from "./roles";
import type { Hub } from "./service";
import { snapshotFiles, workspaceVersion } from "./workspaces";

export interface IncompleteSignal {
  path: string;
  line: number;
  kind: "todo" | "empty" | "placeholder";
  quote: string;
}

export function unfinished(path: string, body: string): IncompleteSignal[] {
  const found: IncompleteSignal[] = [];
  for (const [index, line] of body.split(/\r?\n/).entries()) {
    const kind =
      /^\s*(?:(?:\/\/|#|\/\*|\*|<!--)\s*)?(?:TODO|FIXME|XXX)\b/i.test(line)
        ? "todo"
        : /(?:\bfunction\s*[\w$]*\s*\([^()]*\)|=>)\s*\{\s*\}/.test(line)
          ? "empty"
          : /\b(?:not implemented|placeholder text|lorem ipsum|coming soon)\b|待实现|占位文本/i.test(
                line,
              )
            ? "placeholder"
            : undefined;
    if (kind)
      found.push({
        path,
        line: index + 1,
        kind,
        quote: line.trim().slice(0, 250),
      });
  }
  return found;
}

const textFile =
  /\.(?:[cm]?[jt]sx?|py|go|rs|cs|json|md|txt|html|css|vue|ya?ml|toml)$/i;

export async function collectEvidence(
  hub: Hub,
  loop: Loop,
  task: Task,
  project: Project,
  criteria: Criterion[],
  signal: AbortSignal,
) {
  const workspace = await workspaceVersion(project.path);
  const snapshot = await snapshotFiles(project.path);
  const records = <T>(kind: string, field: "loopId" | "taskId", id: string) =>
    hub.store.db
      .prepare(
        "SELECT data FROM records WHERE kind=? AND json_extract(data,?)=? ORDER BY updated,id",
      )
      .all(kind, "$." + field, id)
      .map((row) => JSON.parse(String(row.data)) as T);
  const checks = records<CheckRun>("check-run", "loopId", loop.id).filter(
    (run) => run.purpose !== "candidate",
  );
  const runs = records<Run>("run", "taskId", task.id);
  const diffs = runs.filter((r) => /^(?:diff --git |@@ )/m.test(r.diff));
  const checked = checks.filter((r) => r.outputRef);
  const changed = new Set(
    runs.flatMap(
      (r) => (hub.store.get("file-check", r.id)?.changed ?? []) as string[],
    ),
  );
  const names = Object.keys(snapshot.files).filter((name) =>
    textFile.test(name),
  );
  names.sort(
    (a, b) =>
      Number(changed.has(b)) - Number(changed.has(a)) ||
      Number(/(?:^|[\\/])(?:readme|agents)\.md$/i.test(b)) -
        Number(/(?:^|[\\/])(?:readme|agents)\.md$/i.test(a)) ||
      a.localeCompare(b),
  );
  const materials: RoleMaterial[] = [];
  const signals: IncompleteSignal[] = [];
  let remaining = 29000;
  for (const name of names.slice(0, 120)) {
    signal.throwIfAborted();
    const hashAtSnapshot = snapshot.files[name].hash;
    const path = join(project.path, name);
    const stat = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return undefined;
    });
    if (!stat?.isFile() || stat.nlink !== 1 || stat.size > 100000) continue;
    const value = await readFile(await within(project.path, path));
    if (value.includes(0) || hash(value) !== hashAtSnapshot) continue;
    const clean = redact(value.toString("utf8"));
    const title = name.replaceAll("\\", "/");
    if (signals.length < 50)
      signals.push(...unfinished(title, clean).slice(0, 50 - signals.length));
    if (remaining > 0 && materials.length < 32) {
      const content = clean.slice(0, Math.min(5000, remaining));
      materials.push({
        id: "file:" + title,
        kind: "file",
        title,
        content,
        sourceVersion: hashAtSnapshot,
        truncated: content.length < clean.length,
      });
      remaining -= content.length;
    }
  }
  for (const run of diffs.slice(-5)) {
    materials.push({
      id: "diff:" + run.id,
      kind: "diff",
      title: "实际差异",
      sourceVersion: run.id,
      content: redact(run.diff.slice(0, 1800)),
      truncated: run.diff.length > 1800,
    });
  }
  // Select the most recent version of each check for calls; every retained run has an output reference below.
  const latest = [
    ...new Map(checked.map((r) => [r.checkId, r])).values(),
  ].slice(-12);
  for (const run of latest) {
    signal.throwIfAborted();
    const content = await hub.loop.output(run.id);
    const check = hub.store.get("check", run.checkId);
    materials.push({
      id: "check:" + run.id,
      kind: "check-output",
      title:
        (check?.input?.name ?? run.purpose) +
        " · " +
        (run.outcome ?? run.state),
      sourceVersion: run.workspaceVersion,
      content: content.slice(-900),
      truncated: content.length > 900,
    });
  }
  const rules = hub
    .rules(project.id)
    .slice(0, 8)
    .map((rule) => rule.text.slice(0, 500));
  const concerns = criteria.flatMap((entry) =>
    entry.passed?.invocationId
      ? ((hub.store.get("invocation", entry.passed.invocationId)?.result
          ?.concerns ?? []) as string[])
      : [],
  );
  return {
    workspace,
    original: userRequest(hub.store, task),
    signals,
    rules,
    concerns: concerns.slice(0, 12),
    materials,
    checkOutputRefs: checked.map(({ id, outputRef }) => ({ id, outputRef })),
    diffRunIds: diffs.map((run) => run.id),
    limited: workspace.truncated || snapshot.truncated || names.length > 120,
  };
}
export type EvidenceBundle = Awaited<ReturnType<typeof collectEvidence>>;
