import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  rename,
  mkdir,
  realpath,
  stat,
} from "node:fs/promises";
import { join, relative, isAbsolute, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const hash = (s: string | Buffer) =>
  createHash("sha256").update(s).digest("hex");
export { redact } from "../shared/redact";
export function childEnv() {
  const keys = [
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATH",
    "Path",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "CODEX_HOME",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "PROGRAMDATA",
  ];
  return Object.fromEntries(
    keys.filter((k) => process.env[k]).map((k) => [k, process.env[k]!]),
  );
}
export function dpapi(input: Buffer, decrypt = false): Promise<Buffer> {
  if (process.platform !== "win32")
    throw new Error("此版本的密钥存储需要 Windows DPAPI");
  const script = `Add-Type -AssemblyName System.Security; $v=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $o=[Security.Cryptography.ProtectedData]::${decrypt ? "Unprotect" : "Protect"}($v,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($o))`;
  return new Promise((resolve, reject) => {
    const p = spawn(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: childEnv() },
    );
    let output = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error("安全凭据服务超时"));
    }, 15000);
    p.stdout.on("data", (x) => (output += x));
    p.on("error", () => {
      clearTimeout(timer);
      reject(new Error("安全凭据服务不可用"));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve(Buffer.from(output, "base64"))
        : reject(new Error("无法解密凭据，请以原 Windows 用户运行或重新配置"));
    });
    p.stdin.end(input.toString("base64"));
  });
}
export class Vault {
  constructor(
    public dir: string,
    public filename = "api-key.dpapi",
  ) {}
  async save(endpoint: string, key: string) {
    if (!key.trim() || key.length > 4000 || /[\r\n]/.test(key))
      throw new Error("密钥格式无效");
    await mkdir(this.dir, { recursive: true });
    const cipher = await dpapi(Buffer.from(key.trim()));
    const file = join(this.dir, this.filename);
    await writeFile(
      file + ".tmp",
      JSON.stringify({ endpoint, cipher: cipher.toString("base64"), revision: randomUUID() }),
      { mode: 0o600 },
    );
    await rename(file + ".tmp", file);
  }
  async configured(endpoint: string) {
    try {
      const v = JSON.parse(
        await readFile(join(this.dir, this.filename), "utf8"),
      );
      return v.endpoint === endpoint;
    } catch {
      return false;
    }
  }
  async revision(endpoint: string) {
    const content = await readFile(join(this.dir, this.filename), "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return undefined;
    });
    if (content === undefined) return;
    const v = JSON.parse(content);
    if (v.endpoint === endpoint && typeof v.revision === "string") return v.revision as string;
  }
  async get(endpoint: string, revision?: string) {
    const v = JSON.parse(await readFile(join(this.dir, this.filename), "utf8"));
    if (v.endpoint !== endpoint || (revision !== undefined && v.revision !== revision))
      throw new Error("凭据目标已变更，请重新配置");
    return (await dpapi(Buffer.from(v.cipher, "base64"), true)).toString();
  }
}
export async function within(root: string, candidate: string) {
  const r = await realpath(root),
    p = await realpath(candidate),
    rel = relative(r, p);
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("文件不在已授权的项目范围内");
  return p;
}
export function attachmentKind(path: string) {
  const ext = extname(path).toLowerCase();
  return [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)
    ? "image"
    : /\.(txt|md|json|ts|tsx|js|jsx|html|css|py|rs|go|cs|yaml|yml|toml|xml|csv|log|diff)$/.test(
          ext,
        )
      ? "text"
      : "binary";
}

export async function fileInfo(path: string) {
  const st = await stat(path);
  if (!st.isFile() || st.size > 20 * 1024 * 1024)
    throw new Error("只支持 20 MB 以内的普通文件");
  const data = await readFile(path);
  return { hash: hash(data), size: st.size, kind: attachmentKind(path), data };
}
