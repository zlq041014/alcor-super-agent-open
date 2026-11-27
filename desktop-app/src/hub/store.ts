import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  copyFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { backupFiles } from "./backup-files";

export const stamp = () => new Date().toISOString();
export const LEDGER_VERSION = 8;
// Older readers cannot interpret backend or loop state. Keep a restorable
// snapshot before publishing the new version fence.
function backupBeforeUpgrade(db: DatabaseSync, dir: string, version: 1 | 2 | 3 | 4 | 5 | 6 | 7) {
  const out = join(
    dir,
    "backups",
    ["pre-dsh-", "pre-loop-", "pre-native-plan-", "pre-outcomes-", "pre-research-", "pre-observation-", "pre-native-agents-"][version - 1] + randomUUID(),
  );
  mkdirSync(join(out, "blobs"), { recursive: true });
  const snapshot = join(out, "state.sqlite");
  db.prepare("VACUUM INTO ?").run(snapshot);
  const digest = (file: string) =>
    createHash("sha256").update(readFileSync(file)).digest("hex");
  let files: Map<string, string>;
  const copy = new DatabaseSync(snapshot, { readOnly: true });
  try {
    files = backupFiles(copy);
  } finally {
    copy.close();
  }
  for (const [name, hash] of files) {
    const path = realpathSync(join(dir, "blobs", name));
    if (dirname(path) !== realpathSync(join(dir, "blobs")))
      throw Error("旧产物不在星引副本目录内");
    const target = join(out, "blobs", name);
    copyFileSync(path, target);
    if (digest(target) !== hash) throw Error("旧产物校验失败");
  }
  writeFileSync(
    join(out, "manifest.json"),
    JSON.stringify({
      schemaVersion: version,
      appVersion: version === 1 ? "pre-0.1.8" : version === 2 ? "0.1.8" : "0.2.0",
      createdAt: stamp(),
      databaseHash: digest(snapshot),
      files: [...files].map(([name, hash]) => ({ name, hash })),
    }),
  );
}
export const entity = () => ({
  id: randomUUID(),
  createdAt: stamp(),
  updatedAt: stamp(),
});
export class Store {
  db: DatabaseSync;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    const v = Number(
      (this.db.prepare("PRAGMA user_version").get() as any).user_version,
    );
    if (v > LEDGER_VERSION) {
      this.db.close();
      throw new Error("数据版本较新，请使用匹配的星引版本");
    }
    this.db.function("alcor_text_contains", { deterministic: true }, (value, term) =>
      Number(typeof value === "string" && typeof term === "string" && value.toLowerCase().includes(term)),
    );
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    if (v === 1 || v === 2 || v === 3 || v === 4 || v === 5 || v === 6 || v === 7) {
      try {
        backupBeforeUpgrade(this.db, dir, v);
      } catch {
        this.db.close();
        throw new Error(
          "升级前备份失败，旧账本未升级。请检查磁盘空间和产物副本。",
        );
      }
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),updated TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, dedup TEXT UNIQUE, kind TEXT NOT NULL, object_id TEXT, at TEXT NOT NULL, metadata TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tombstones(id TEXT PRIMARY KEY,at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_kind_updated ON records(kind,updated);
      PRAGMA user_version=${LEDGER_VERSION};`);
  }
  get<T = any>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id) as any;
    return row ? JSON.parse(row.data) : undefined;
  }
  all<T = any>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY updated ASC")
      .all(kind)
      .map((r: any) => JSON.parse(r.data));
  }
  put(kind: string, data: any) {
    this.db
      .prepare(
        "INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated=excluded.updated",
      )
      .run(kind, data.id, JSON.stringify(data), data.updatedAt || stamp());
    return data;
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  event(
    kind: string,
    objectId: string,
    metadata: Record<string, unknown> = {},
    dedup?: string,
  ) {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO events(dedup,kind,object_id,at,metadata) VALUES(?,?,?,?,?)",
        )
        .run(dedup || null, kind, objectId, stamp(), JSON.stringify(metadata))
        .changes > 0
    );
  }
  close() {
    this.db.close();
  }
}
