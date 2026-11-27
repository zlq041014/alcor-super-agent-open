import path from "node:path";
import type { WorkFile, WorkStep } from "../shared/contracts";
import { redact } from "./security";
export const sensitive = (p: string) =>
  /(?:^|[\\/])(?:\.env(?:\.|$)|[^\\/]*\.(?:pem|key|p12|pfx|dpapi)$|id_(?:rsa|ed25519)$|credentials(?:\.[^\\/]*)?$|auth\.json$)/i.test(
    p,
  );
export function publicDiff(raw: string) {
  return String(raw)
    .split(/^(?=diff --git )/m)
    .map((part) => {
      const paths = part.match(/^(?:---|\+\+\+) (?:a\/|b\/)?[^\r\n]+/gm) || [];
      const hdr = part.split("\n", 1)[0];
      return paths.some((p) =>
        sensitive(
          p
            .replace(/^(?:---|\+\+\+) (?:a\/|b\/)?/, "")
            .split("\t")[0]
            .replaceAll('"', "")
            .trim(),
        ),
      ) ||
        (/^diff --git/.test(hdr) &&
          hdr.split(/\s+/).some((p) => sensitive(p.replaceAll('"', ""))))
        ? "[敏感文件补丁已隐藏]\n"
        : redact(part);
    })
    .join("")
    .slice(0, 300000);
}
const cut = (s: string, n: number) =>
  s.length > n ? s.slice(0, n) + "\n… 已截断" : s;
export function displayPath(root: string, p: string) {
  const r = path.isAbsolute(p) ? path.relative(root, p) : p;
  return redact(r.split(path.sep).join("/")).slice(0, 500);
}
export function patchStats(
  diff: string,
  op: string,
): { added?: number; removed?: number } {
  if (!diff || /^Binary files|^GIT binary patch/m.test(diff)) return {};
  const rows = diff.replaceAll("\r\n", "\n").split("\n");
  let hunk = false,
    found = false,
    added = 0,
    removed = 0;
  for (const row of rows) {
    if (/^@@(?: |$)|^\*\*\* (?:Add|Delete|Update) File:/.test(row)) {
      hunk = true;
      found = true;
      continue;
    }
    if (/^diff --git |^\*\*\* End Patch/.test(row)) {
      hunk = false;
      continue;
    }
    if (hunk) {
      if (row.startsWith("+")) added++;
      else if (row.startsWith("-")) removed++;
    }
  }
  if (found) return { added, removed };
  if (op === "add" || op === "delete") {
    if (/^diff --git|^--- |^\+\+\+ |^\*\*\* /.test(diff)) return {};
    const count = rows.length - (rows.at(-1) === "" ? 1 : 0);
    return {
      added: op === "add" ? count : 0,
      removed: op === "delete" ? count : 0,
    };
  }
  return {};
}
export function describeFiles(changes: any, root: string): WorkFile[] {
  if (!Array.isArray(changes)) return [];
  let remaining = 40000;
  return changes.slice(0, 100).map((x) => {
    const p = String(x.path || ""),
      k = x.kind?.type || x.kind;
    const action: WorkFile["action"] =
      k === "add"
        ? "新增"
        : k === "delete"
          ? "删除"
          : x.kind?.move_path || x.kind?.movePath
            ? "移动"
            : k === "update"
              ? "修改"
              : "版本变化";
    if (sensitive(p))
      return { path: "敏感文件", action, note: "不展示此文件的内容和统计。" };
    const raw = typeof x.diff === "string" ? x.diff : "";
    const patch =
      remaining > 0 && raw
        ? cut(redact(raw), Math.min(12000, remaining))
        : undefined;
    remaining -= patch?.length || 0;
    return {
      path: displayPath(root, p),
      action,
      ...patchStats(raw, k),
      patch,
      note: !patch ? "没有可展示的逐行补丁。" : undefined,
    };
  });
}
export function nativeStep(
  item: any,
  root: string,
  ended: boolean,
): Omit<WorkStep, "id" | "at"> | undefined {
  const state: WorkStep["state"] = !ended
    ? "running"
    : item.status === "failed" ||
        item.success === false ||
        !!item.error ||
        (typeof item.exitCode === "number" && item.exitCode !== 0)
      ? "failed"
      : item.status === "declined" ||
          item.status === "cancelled" ||
          item.status === "interrupted"
        ? "stopped"
        : "done";
  const durationMs =
    typeof item.durationMs === "number" ? item.durationMs : undefined;
  if (item.type === "commandExecution")
    return {
      kind: "command",
      state,
      title: cut(redact(String(item.command || "运行命令")), 4500),
      detail: cut(redact(String(item.aggregatedOutput || "")), 36000),
      exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
      durationMs,
    };
  if (item.type === "fileChange")
    return {
      kind: "file",
      state,
      title: "文件修改",
      files: describeFiles(item.changes, root),
    };
  if (item.type === "imageView" || item.type === "imageGeneration") {
    const p = item.path || item.savedPath;
    return {
      kind: "image",
      state,
      title: item.type === "imageView" ? "查看图像" : "生成图像",
      detail: typeof p === "string" ? displayPath(root, p) : undefined,
    };
  }
  const title: Record<string, string> = {
    mcpToolCall: "调用 MCP 工具",
    dynamicToolCall: "调用工具",
    webSearch: "搜索",
    collabAgentToolCall: "Agent 协作",
    contextCompaction: "整理上下文",
  };
  if (title[item.type]) {
    const outputs =
      item.type === "mcpToolCall"
        ? item.result?.content
        : item.type === "dynamicToolCall"
          ? item.contentItems
          : undefined;
    const result = Array.isArray(outputs)
      ? outputs
          .filter(
            (c) =>
              ["text", "inputText", "outputText"].includes(c?.type) &&
              typeof c.text === "string",
          )
          .slice(0, 8)
          .map((c) => c.text)
          .join("\n")
      : undefined;
    const detail =
      item.type === "webSearch" && typeof item.query === "string"
        ? item.query
        : result || (item.error?.message && String(item.error.message));
    return {
      kind: item.type === "collabAgentToolCall" ? "delegate" : "tool",
      state,
      title: redact(
        [title[item.type], item.server, item.tool]
          .filter((x) => typeof x === "string" && x)
          .join(" · "),
      ).slice(0, 500),
      durationMs,
      detail: detail ? cut(redact(detail), 8000) : undefined,
    };
  }
}
export function verifiedFiles(
  root: string,
  changed: string[],
  deleted: string[],
  diff: string,
): WorkFile[] {
  const out = new Map<string, WorkFile>();
  for (const patch of diff.split(/^(?=diff --git )/m)) {
    if (!patch.startsWith("diff --git ")) continue;
    const plus = /^\+\+\+ (?:b\/)?([^\t\r\n]+)/m.exec(patch)?.[1],
      minus = /^--- (?:a\/)?([^\t\r\n]+)/m.exec(patch)?.[1];
    const file = plus && plus !== "/dev/null" ? plus : minus;
    if (
      !file ||
      file === "/dev/null" ||
      sensitive(file) ||
      file.startsWith('"')
    )
      continue;
    const [f] = describeFiles(
      [
        {
          path: file,
          kind: {
            type:
              minus === "/dev/null"
                ? "add"
                : plus === "/dev/null"
                  ? "delete"
                  : "update",
          },
          diff: patch,
        },
      ],
      root,
    );
    out.set(f.path, f);
  }
  for (const p of [...changed, ...deleted]) {
    const path = sensitive(p) ? "敏感文件" : displayPath(root, p);
    if (!out.has(path))
      out.set(path, {
        path,
        action: "版本变化",
        note: deleted.includes(p)
          ? "执行后未在扫描范围内发现此文件；未记录逐行补丁。"
          : "执行前后文件版本不同；未记录逐行补丁。",
      });
  }
  let remaining = 40000;
  return [...out.values()].slice(0, 100).map((f) => {
    if (!f.patch) return f;
    const patch = remaining > 0 ? cut(f.patch, remaining) : undefined;
    remaining -= patch?.length || 0;
    return { ...f, patch, note: patch ? f.note : "变更详情达到本次显示上限。" };
  });
}
