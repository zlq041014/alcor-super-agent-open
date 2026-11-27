import { useSyncExternalStore } from "react";
import { redact } from "../shared/redact";

export type Echo = {
  id: string;
  at: string;
  text: string;
  label: string;
  state: "sending" | "accepted" | "failed" | "unknown";
  detail?: string;
  turnId?: string;
};
const empty: readonly Echo[] = [],
  byThread = new Map<string, readonly Echo[]>(),
  subscribers = new Set<() => void>();
const active = new Map<string, string>();
function set(scope: string, entries: readonly Echo[]) {
  if (entries.length) byThread.set(scope, entries);
  else byThread.delete(scope);
  for (const cb of subscribers) cb();
}
function subscribe(cb: () => void) {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
export const outgoing = {
  list: (scope: string) => byThread.get(scope) || empty,
  busy: (scope: string) => active.has(scope),
  begin(scope: string, text: string, label: string) {
    const echo: Echo = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      text: redact(text),
      label,
      state: "sending",
    };
    active.set(scope, echo.id);
    set(scope, [...this.list(scope), echo]);
    return echo;
  },
  finish(scope: string, id: string) {
    if (active.get(scope) === id) {
      active.delete(scope);
      for (const cb of subscribers) cb();
    }
  },
  update(
    scope: string,
    id: string,
    patch: Partial<Pick<Echo, "state" | "detail" | "turnId">>,
  ) {
    const entries = this.list(scope);
    if (entries.some((x) => x.id === id))
      set(
        scope,
        entries.map((x) => (x.id === id ? { ...x, ...patch } : x)),
      );
  },
  reconcile(scope: string, durableIds: Iterable<string>) {
    const entries = this.list(scope);
    if (!entries.length) return;
    const ids = new Set(durableIds),
      left = entries.filter((e) => !ids.has(e.id));
    if (left.length !== entries.length) set(scope, left);
  },
  forget(scope: string, id: string) {
    this.reconcile(scope, [id]);
  },
  reject(scope: string, id: string, error: unknown) {
    const detail = redact(String((error as Error)?.message || error))
      .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")
      .slice(0, 240);
    const uncertain =
      /未知|核对.*勿重复|超时|中断|断开|断连|Hub 不可用|channel closed|connection|ipc.*closed|destroyed|disconnect/i.test(
        detail,
      );
    this.update(scope, id, { state: uncertain ? "unknown" : "failed", detail });
  },
};
export function useOutgoing(scope: string) {
  return useSyncExternalStore(subscribe, () => outgoing.list(scope));
}
export function useSending(scope: string) {
  return useSyncExternalStore(subscribe, () => outgoing.busy(scope));
}
export function withEchoes<T extends { id: string; createdAt: string }>(
  rows: readonly T[],
  entries: readonly Echo[],
  map: (e: Echo) => T,
): T[] {
  const ids = new Set(rows.map((r) => r.id)),
    extra = entries.map(map).filter((r) => !ids.has(r.id));
  if (!extra.length) return [...rows];
  // Preserve the ledger's arrival order; insert local-only rows where they were submitted.
  const result = [...rows];
  for (const r of extra) {
    const i = result.findIndex((x) => x.createdAt > r.createdAt);
    if (i === -1) result.push(r);
    else result.splice(i, 0, r);
  }
  return result;
}
export const echoLabels = {
  sending: "正在发送…",
  accepted: "已提交",
  failed: "未发送",
  unknown: "送达未确认",
};
