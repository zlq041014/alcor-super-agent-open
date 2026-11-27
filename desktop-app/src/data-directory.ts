import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export function canonicalDataDirectory(path: string) {
  const absolute = resolve(path);
  mkdirSync(absolute, { recursive: true });
  return realpathSync.native(absolute);
}

export function desktopDataDirectory(bootstrap: string, override?: string) {
  if (override) return canonicalDataDirectory(override);
  let saved: unknown;
  try {
    saved = JSON.parse(readFileSync(join(bootstrap, "location.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return canonicalDataDirectory(join(bootstrap, "default"));
    throw new Error(
      "数据目录配置无法读取。请检查 location.json；没有切换到其他账本。",
      { cause: error },
    );
  }
  if (
    !saved ||
    typeof saved !== "object" ||
    !("dataDir" in saved) ||
    typeof saved.dataDir !== "string" ||
    !isAbsolute(saved.dataDir)
  )
    throw new Error(
      "location.json 必须包含有效的绝对数据目录；没有切换到其他账本。",
    );
  return canonicalDataDirectory(saved.dataDir);
}

export function saveDesktopDataDirectory(
  bootstrap: string,
  selectedPath: string,
) {
  const dataDir = canonicalDataDirectory(selectedPath);
  mkdirSync(bootstrap, { recursive: true });
  const target = join(bootstrap, "location.json");
  const tmp = target + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify({ dataDir }), { flag: "wx" });
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return dataDir;
}
