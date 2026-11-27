import { execFile } from "node:child_process";
import { opendir } from "node:fs/promises";
import { promisify } from "node:util";
import { normalize } from "node:path";
import { verifiedDir } from "./local-projects";
import { childEnv } from "./security";

const exec = promisify(execFile);
const limit = 30;

export async function readLocalFolder(path: string, probe = false) {
  const root = await verifiedDir(path, true);
  const dir = await opendir(root);
  if (probe) {
    await dir.close();
    return "可以。我刚用本机文件系统打开目录验证过，Codex 离线不影响读取。发我一个本机文件夹路径，我可以直接列出里面的文件和子目录。新建或修改文件时，按对应项目工作的写入范围执行。";
  }
  const entries: string[] = [];
  for await (const entry of dir) {
    if (entries.length === limit)
      return root + " 的直属项（仅显示前 30 项）：\n" + entries.join("\n");
    entries.push("- " + entry.name + (entry.isDirectory() ? "/" : ""));
  }
  return root + (entries.length
    ? " 的直属项：\n" + entries.join("\n")
    : " 是空文件夹。");
}

export async function findLocalNames(
  executable: string | undefined,
  roots: string[],
  name: string,
  kind: "f" | "d",
) {
  if (!executable) throw new Error("此版本未提供本机文件查找工具 fd");
  if (!roots.length)
    return "请在命令中指定位置，例如「在 D:\\projects 查找文件 manifest.js」，或在项目页添加查找位置。";

  const paths: string[] = [], unavailable: string[] = [];
  for (const root of roots) {
    try {
      paths.push(await verifiedDir(root, true));
    } catch {
      unavailable.push(root);
    }
  }
  if (!paths.length) throw new Error("无法访问查找位置：" + unavailable.join("、"));
  const args = [
    "--absolute-path", "--fixed-strings", "--ignore-case", "--no-ignore",
    "--type", kind, "--max-results", String(limit + 1), "--show-errors",
    "--color", "never", "--print0",
    ...["node_modules", "System Volume Information", "$RECYCLE.BIN"].flatMap((entry) => ["--exclude", entry]),
    ...paths.flatMap((path) => ["--search-path", path]),
    "--", name,
  ];
  const { stdout, stderr } = await exec(executable, args, {
    cwd: paths[0],
    env: childEnv(),
    windowsHide: true,
    timeout: 8000,
    maxBuffer: 512 * 1024,
  }).catch((error: NodeJS.ErrnoException & { killed?: boolean }) => {
    throw new Error(
      error.killed
        ? "文件查找超时，请缩小查找范围。"
        : "本机文件查找失败（" + (error.code ?? "fd") + "）。",
      { cause: error },
    );
  });
  const matches = stdout.split("\0").filter(Boolean).map((path) =>
    normalize(path).replace(/[\\/]+$/, ""),
  );
  return [
    "查找位置：" + paths.join("、"),
    matches.length
      ? "匹配路径：\n" + matches.slice(0, limit).map((path) => "- " + path).join("\n")
      : "没有找到匹配的名称。",
    ...(matches.length > limit ? ["结果达到 30 条，请缩小查找范围。"] : []),
    ...(unavailable.length ? ["未能访问：" + unavailable.join("、")] : []),
    ...(stderr.trim() ? ["部分目录无法检查，结果可能不完整。"] : []),
  ].join("\n\n");
}
