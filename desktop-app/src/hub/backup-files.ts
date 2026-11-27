import type { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import { z } from "zod";
import type { GraphFile } from "../shared/native-graph";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.object({ name: z.string().min(1).max(255), hash: digest });
const manifest = z.object({
  schemaVersion: z.number().int().min(1),
  databaseHash: digest,
  files: z.array(file),
});

export function readBackupManifest(value: unknown, maxVersion: number) {
  const result = manifest.safeParse(value);
  if (!result.success || result.data.schemaVersion > maxVersion)
    throw new Error("备份清单版本或校验字段无效");
  return result.data;
}

export function backupFiles(db: DatabaseSync) {
  const files = new Map<string, string>();
  function add(name: string, hash: string) {
    if (
      !digest.safeParse(hash).success ||
      !/^[a-f0-9]{64}(?:\.[^<>:"/\\|?*\x00-\x1f.]+)?$/.test(name) ||
      name.slice(0, 64) !== hash
    )
      throw new Error("账本副本名称或摘要无效");
    files.set(name, hash);
  }
  for (const row of db
    .prepare(
      `SELECT kind,data FROM records WHERE kind IN
        ('artifact','check-run','file-journal','native-graph','graph-node')`,
    )
    .iterate()) {
    const record = JSON.parse(String(row.data));
    if (
      row.kind === "artifact" &&
      (record.origin === "attachment" || record.sourcePath)
    )
      add(basename(record.path), record.hash);
    else if (row.kind === "check-run" && record.outputRef)
      add(record.outputRef, record.outputRef);
    else if (row.kind === "file-journal") {
      for (const ref of [record.preRef, record.postRef]) if (ref) add(ref, ref);
    } else if (row.kind === "native-graph" || row.kind === "graph-node") {
      if (row.kind === "native-graph" && record.preview)
        add(record.preview.blob, record.preview.blob.slice(0, 64));
      const graphFiles: GraphFile[] = row.kind === "native-graph" ? [...record.inputs, ...(record.assembled?.files ?? [])] :
        [...(record.accepted?.files ?? []), ...(record.draft?.files ?? []), ...(record.repair?.files ?? [])];
      for (const { blob } of graphFiles) add(blob, blob.slice(0, 64));
    }
  }
  return files;
}
