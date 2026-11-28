import type { Artifact, Run } from "./contracts";

export const resultArtifacts = (artifacts: Artifact[], run: Pick<Run, "id" | "taskId">) =>
  artifacts.filter(item => item.origin === "result" && item.taskId === run.taskId && item.runId === run.id);

export function resultEvidence(run: Pick<Run, "id" | "response" | "diff">, artifacts: Artifact[]) {
  const files = artifacts.map(({ id, hash }) => [id, hash]);
  files.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return JSON.stringify([run.id, run.response, run.diff, files]);
}
