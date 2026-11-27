import { redact } from "./security";
import { stamp, type Store } from "./store";
import { samePath } from "./local-projects";

export class NativeReadUnavailable extends Error {}

export interface NativeCache<T> {
  id: string;
  path: string;
  fetchedAt: string;
  value: T;
}
export interface NativeList {
  items: { id: string; title: string; projectId: string | null; cwd: string }[];
  incomplete: boolean;
}
export interface NativeHistory {
  title: string;
  turns: ReturnType<typeof publicNativeHistory>;
}
type NativeCacheKind = "native-list" | "native-history" | "dsh-native-list" | "dsh-native-history";

export function cachedNative<T>(
  store: Store,
  kind: NativeCacheKind,
  id: string,
  path: string,
) {
  const record = store.get<NativeCache<T>>(kind, id);
  return record && samePath(record.path, path) ? record : undefined;
}

export function saveNative<T>(
  store: Store,
  kind: NativeCacheKind,
  id: string,
  path: string,
  value: T,
) {
  const fetchedAt = stamp();
  const record = { id, path, fetchedAt, updatedAt: fetchedAt, value };
  store.tx(() => {
    store.put(kind, record);
    store.db
      .prepare(
        "DELETE FROM records WHERE kind=? AND id IN (SELECT id FROM records WHERE kind=? ORDER BY updated DESC,id LIMIT -1 OFFSET 40)",
      )
      .run(kind, kind);
  });
  return fetchedAt;
}

// Retain a bounded public projection, newest messages first for budget allocation.
export function publicNativeHistory(turns: any[]) {
  let budget = 80000;
  return turns
    .filter((turn: any) => typeof turn?.id === "string")
    .slice(-20)
    .reverse()
    .map((turn: any) => {
      const items = (Array.isArray(turn?.items) ? turn.items : [])
        .filter(
          (i: any) =>
            i &&
            typeof i.id === "string" &&
            (i.type === "userMessage" || i.type === "agentMessage"),
        )
        .slice(-30)
        .reverse()
        .flatMap((item: any) => {
          if (budget <= 0) return [];
          const input = item.type === "userMessage";
          const raw = input
            ? (Array.isArray(item.content) ? item.content : [])
                .filter(
                  (c: any) => c?.type === "text" && typeof c.text === "string",
                )
                .map((c: any) => c.text)
                .join("\n")
            : typeof item.text === "string"
              ? item.text
              : "";
          const text = redact(raw).slice(
            0,
            Math.min(budget, input ? 24000 : 60000),
          );
          budget -= text.length;
          return input
            ? {
                id: item.id,
                clientId:
                  typeof item.clientId === "string" ? item.clientId : undefined,
                type: "userMessage" as const,
                content: [{ type: "text" as const, text }],
              }
            : { id: item.id, type: "agentMessage" as const, text };
        })
        .reverse();
      const status = [
        "completed",
        "failed",
        "interrupted",
        "inProgress",
      ].includes(turn.status)
        ? turn.status
        : "unknown";
      return { id: turn.id, status, items };
    })
    .reverse();
}
