import {
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  rmdirSync,
  readdirSync,
  type Stats,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative as relativePath,
  resolve,
} from "node:path";
import { randomUUID } from "node:crypto";
import type { JournalSink } from "../adapter/dsh-files";
import { pathKey } from "../core/glob";
import { fileDiff } from "../core/diff";
import type { Run, WorkFile } from "../shared/contracts";
import { LoopRelativePath } from "../shared/loop-contracts";
import { checkOutputBlob } from "./checks";
import { hash } from "./security";
import { entity, stamp, Store } from "./store";

type JournalRecord = Omit<ReturnType<typeof entity>, "id"> & {
  id: string;
  loopId: string;
  criterionId: string;
  runId: string;
  seq: number;
  path: string;
  action: "create" | "modify" | "mkdir";
  preRef?: string;
  postRef?: string;
  postHash?: string;
  directoryId?: string;
  restored?: "restoring" | "done" | "skipped_external_change";
};
type Checkpoint = { loopId: string; criterionId: string; uptoSeq: number };
type Target = {
  path: string;
  value: string | null;
  kind: "file" | "directory" | "missing" | "other";
};

function directoryId(info: Stats) {
  return (
    String(info.dev) + ":" + String(info.ino) + ":" + String(info.birthtimeMs)
  );
}
function missing(e: unknown) {
  return ["ENOENT", "ENOTDIR"].includes(
    (e as NodeJS.ErrnoException).code || "",
  );
}
function ownedTarget(
  root: string,
  name: string,
  expected: JournalRecord["action"],
): Target | undefined {
  const relative = LoopRelativePath.safeParse(name);
  if (!relative.success || name === ".") return;
  const path = resolve(root, relative.data);
  const scoped = relativePath(root, path);
  if (
    !scoped ||
    isAbsolute(scoped) ||
    scoped === ".." ||
    /^[.][.][\\/]/.test(scoped)
  )
    return;
  try {
    if (pathKey(realpathSync(root)) !== pathKey(root)) return;
  } catch (e) {
    if (!missing(e)) throw e;
    return;
  }
  try {
    if (pathKey(realpathSync(dirname(path))) !== pathKey(dirname(path))) return;
    const file = lstatSync(path);
    if (file.isSymbolicLink() || pathKey(realpathSync(path)) !== pathKey(path))
      return;
    if (expected === "mkdir" && file.isDirectory())
      return { path, value: directoryId(file), kind: "directory" };
    if (
      expected !== "mkdir" &&
      file.isFile() &&
      file.nlink === 1 &&
      file.size <= 256 * 1024
    )
      return { path, value: hash(readFileSync(path)), kind: "file" };
    return { path, value: null, kind: "other" };
  } catch (e) {
    if (!missing(e)) throw e;
    return { path, value: null, kind: "missing" };
  }
}

export class Journal {
  constructor(
    private readonly store: Store,
    private readonly dataDir: string,
  ) {}
  private records<T>(kind: string, loopId: string): T[] {
    return this.store.db
      .prepare(
        "SELECT data FROM records WHERE kind=? AND json_extract(data,'$.loopId')=?",
      )
      .all(kind, loopId)
      .map((row) => JSON.parse(String(row.data)) as T);
  }
  private sequence(loop: string) {
    return Number(
      this.store.db
        .prepare(
          "SELECT coalesce(max(json_extract(data,'$.seq')),0) AS n FROM records WHERE kind='file-journal' AND json_extract(data,'$.loopId')=?",
        )
        .get(loop)?.n,
    );
  }
  sink(
    run: Pick<Run, "id" | "workPath">,
    loopId: string,
    criterionId: string,
    ensureActive: () => void,
  ) {
    const id = (path: string) => run.id + ":" + pathKey(path);
    const get = (path: string) =>
      this.store.get<JournalRecord>("file-journal", id(path));
    const before = (
      path: string,
      action: JournalRecord["action"],
      preRef?: string,
    ) => {
      this.store.tx(() => {
        const prior = get(path);
        if (prior) {
          if (
            prior.action === "mkdir" ||
            prior.restored ||
            (prior.postHash ?? prior.preRef) !== preRef
          )
            throw new Error("文件在上一笔记录后发生了变化，保留现有内容");
          return;
        }
        this.store.put("file-journal", {
          ...entity(),
          id: id(path),
          loopId,
          criterionId,
          runId: run.id,
          seq: this.sequence(loopId) + 1,
          path,
          action,
          preRef,
        } satisfies JournalRecord);
      });
    };
    return {
      ensureActive,
      before: async (path: string, contents: Buffer | null) => {
        ensureActive();
        const pre =
          contents === null
            ? undefined
            : await checkOutputBlob(this.dataDir, contents);
        ensureActive();
        before(path, contents === null ? "create" : "modify", pre);
      },
      after: async (path: string, contents: Buffer) => {
        const current = get(path)!;
        const digest = await checkOutputBlob(this.dataDir, contents);
        this.store.put("file-journal", {
          ...current,
          postRef: digest,
          postHash: digest,
          updatedAt: stamp(),
        });
      },
      directory: (path: string) => {
        ensureActive();
        before(path, "mkdir");
      },
      directoryCreated: (path: string) => {
        const current = get(path)!;
        const target = ownedTarget(run.workPath, path, "mkdir");
        if (target?.kind === "directory")
          this.store.put("file-journal", {
            ...current,
            directoryId: target.value,
            updatedAt: stamp(),
          });
      },
    } satisfies Omit<JournalSink, "rejected">;
  }
  private blob(ref: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(ref)) throw new Error("文件镜像标识无效");
    const body = readFileSync(join(this.dataDir, "blobs", ref));
    if (hash(body) !== ref) throw new Error("文件镜像内容与记录不符");
    return body;
  }
  files(run: Run, loopId: string): WorkFile[] {
    return this.records<JournalRecord>("file-journal", loopId)
      .filter((row) => row.runId === run.id && row.postRef)
      .sort((a, b) => a.seq - b.seq)
      .flatMap((row) => {
        const previous = row.preRef
          ? this.blob(row.preRef).toString("utf8")
          : null;
        const result = fileDiff(
          row.path,
          previous,
          this.blob(row.postRef!).toString("utf8"),
        );
        return result ? [result] : [];
      });
  }
  checkpoint(
    loopId: string,
    criterionId: string,
    workspaceVersion: string,
    uptoRunId?: string,
  ) {
    this.store.put("checkpoint", {
      ...entity(),
      loopId,
      criterionId,
      uptoRunId,
      uptoSeq: this.sequence(loopId),
      workspaceVersion,
    });
  }
  private pending(loopId: string, criterionId?: string) {
    const checkpoints = new Map<string, number>();
    for (const row of this.records<Checkpoint>("checkpoint", loopId))
      checkpoints.set(
        row.criterionId,
        Math.max(checkpoints.get(row.criterionId) || 0, row.uptoSeq),
      );
    return this.records<JournalRecord>("file-journal", loopId)
      .filter(
        (row) =>
          (!criterionId || row.criterionId === criterionId) &&
          row.seq > (checkpoints.get(row.criterionId) || 0) &&
          row.restored !== "done",
      )
      .sort((a, b) => b.seq - a.seq);
  }
  unrestored(loopId: string, criterionId?: string) {
    return [
      ...new Set(this.pending(loopId, criterionId).map((row) => row.path)),
    ];
  }
  rollback(loopId: string, root: string, criterionId?: string) {
    let restored = 0;
    const skipped = new Set<string>();
    const broken = new Set<string>();
    for (const row of this.pending(loopId, criterionId)) {
      if (row.restored === "skipped_external_change") {
        skipped.add(row.path);
        broken.add(pathKey(row.path));
        continue;
      }
      const save = (state: JournalRecord["restored"]) =>
        this.store.put("file-journal", {
          ...row,
          restored: state,
          updatedAt: stamp(),
        });
      const skip = () => {
        skipped.add(row.path);
        broken.add(pathKey(row.path));
        save("skipped_external_change");
      };
      if (broken.has(pathKey(row.path))) {
        skip();
        continue;
      }
      const target = ownedTarget(root, row.path, row.action);
      const old = row.preRef ?? null;
      if (
        target &&
        target.kind !== "other" &&
        target.value === old &&
        (row.restored === "restoring" || (!row.postHash && !row.directoryId))
      ) {
        save("done");
        continue;
      }
      const expected = row.action === "mkdir" ? row.directoryId : row.postHash;
      if (
        !target ||
        target.kind === "other" ||
        !expected ||
        target.value !== expected ||
        (target.kind === "directory" && readdirSync(target.path).length > 0)
      ) {
        skip();
        continue;
      }
      save("restoring");
      if (row.action === "mkdir" || row.action === "create") {
        if (ownedTarget(root, row.path, row.action)?.value !== expected) {
          skip();
          continue;
        }
        try {
          if (row.action === "mkdir") rmdirSync(target.path);
          else unlinkSync(target.path);
        } catch (e) {
          if (!missing(e) && (e as NodeJS.ErrnoException).code !== "ENOTEMPTY")
            throw e;
          skip();
          continue;
        }
      } else {
        const temp = join(
          dirname(target.path),
          ".alcor-rollback-" + randomUUID(),
        );
        try {
          writeFileSync(temp, this.blob(row.preRef!), { flag: "wx" });
          if (ownedTarget(root, row.path, row.action)?.value !== expected) {
            skip();
            continue;
          }
          renameSync(temp, target.path);
        } finally {
          try {
            unlinkSync(temp);
          } catch (e) {
            if (!missing(e)) throw e;
          }
        }
      }
      save("done");
      restored++;
    }
    if (restored || skipped.size)
      this.store.event("rollback.applied", loopId, {
        criterionId,
        restored,
        skipped: [...skipped],
      });
    return { restored, skipped: [...skipped] };
  }
}
