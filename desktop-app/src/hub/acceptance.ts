import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { within, hash, fileInfo } from "./security";
export async function verifyFiles(
  root: string,
  checks: { path: string; contains: string }[],
) {
  const evidence = [];
  for (const check of checks) {
    try {
      const path = await within(root, resolve(root, check.path));
      const info = await fileInfo(path);
      if (info.kind === "binary" || info.kind === "image")
        throw new Error("仅支持文本文件检查");
      const passed =
        !check.contains || info.data.toString("utf8").includes(check.contains);
      evidence.push({
        path: check.path,
        passed,
        hash: info.hash,
        reason: passed ? "文件及内容满足预先约定的检查" : "文件未包含约定内容",
      });
    } catch {
      evidence.push({
        path: check.path,
        passed: false,
        reason: "文件缺失、超出范围或无法核对",
      });
    }
  }
  return { passed: evidence.every((e) => e.passed), evidence };
}
