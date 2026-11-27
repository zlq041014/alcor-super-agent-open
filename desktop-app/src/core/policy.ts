import type { Task, TaskState } from "../shared/contracts";

const allowed: Record<TaskState, TaskState[]> = {
  draft: ["ready", "verifying", "blocked", "paused", "cancelled"],
  ready: ["draft", "active", "verifying", "blocked", "paused", "cancelled"],
  active: ["verifying", "blocked", "paused", "cancelled"],
  blocked: ["draft", "ready", "active", "verifying", "paused", "cancelled"],
  paused: ["draft", "ready", "blocked", "active", "verifying", "cancelled"],
  verifying: ["done", "ready", "blocked", "paused", "cancelled"],
  done: ["ready", "blocked"],
  cancelled: [],
};
export function transition(task: Task, to: TaskState): Task {
  if (task.state !== to && !allowed[task.state].includes(to))
    throw new Error("不允许的任务状态转换");
  return {
    ...task,
    state: to,
    stateVersion: task.stateVersion + 1,
    updatedAt: new Date().toISOString(),
  };
}
export function assertRevision(task: Task, revision: number) {
  if (task.revision !== revision)
    throw new Error("任务要求已更新，请刷新后再操作");
}
export function overlaps(a: string, b: string): boolean {
  const norm = (p: string) =>
    p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const x = norm(a),
    y = norm(b);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}
export function canSchedule(
  task: Task,
  tasks: Task[],
  activePaths: string[],
  path: string,
  maxRuns: number,
) {
  return (
    task.state === "ready" &&
    task.attempt < maxRuns &&
    task.dependencies.every((id) =>
      tasks.some((t) => t.id === id && t.state === "done"),
    ) &&
    !activePaths.some((p) => overlaps(p, path))
  );
}
export function endpointUrl(endpoint: string, route: string) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("服务地址需要 HTTPS，本机调试可使用回环 HTTP");
  if (url.username || url.password || url.search || url.hash)
    throw new Error("服务地址不能包含认证信息、查询参数或片段");
  url.pathname = url.pathname.replace(/\/+$/, "") + "/" + route;
  return url.toString();
}
