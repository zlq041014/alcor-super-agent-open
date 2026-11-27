import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rmdir, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { attachmentKind } from "./security";

export const mobileExcerptLimit = 2500;
const key = z.string().min(1).max(200);
export const materialHeader = z.object({
  requestId: z.string().uuid(), slot: z.number().int().min(0).max(2),
  count: z.number().int().min(1).max(3),
  projectId: key, version: key, expiresAt: z.number().int(),
  name: z.string().min(1).max(255).refine((x) => !/[<>:"/\\|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(x)),
  mode: z.enum(["original", "excerpt"]),
}).strict().refine((info) => info.slot < info.count);
export type MaterialHeader = z.infer<typeof materialHeader>;
export const materialRef = z.object({
  slot: z.number().int().min(0).max(2),
  version: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
type Staged = { dir: string; path: string; hash: string; length: number };
export type MobileMaterial = Staged & MaterialHeader & { id: string; device: string };

export function readMaterialHeader(req: IncomingMessage) {
  const value = req.headers["x-alcor-material"];
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,2700}$/.test(value))
    throw new Error("缺少有效的手机材料信息");
  return materialHeader.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
}

export async function readMobileExcerpt(path: string, version?: string) {
  const content = await readFile(path);
  if (version && createHash("sha256").update(content).digest("hex") !== version)
    throw new Error("文字摘录版本已变化");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  if (!text.trim() || text.length > mobileExcerptLimit) throw new Error("文字摘录为空或超过长度限制");
  return text;
}

export async function stageMobileMaterial(req: IncomingMessage, root: string, info: MaterialHeader): Promise<Staged> {
  const limit = info.mode === "excerpt" ? mobileExcerptLimit * 4 : 20 * 1024 * 1024;
  const declared = req.headers["content-length"];
  const size = typeof declared === "string" && /^\d{1,8}$/.test(declared) ? Number(declared) : 0;
  if (req.headers["content-type"] !== "application/octet-stream" || size < 1 || size > limit)
    throw new Error("材料大小或传输类型无效");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "file-"));
  const path = join(dir, info.mode === "excerpt" ? info.name.slice(0, 236) + "-摘录.txt" : info.name);
  let length = 0;
  const digest = createHash("sha256");
  const decoder = info.mode === "original" && attachmentKind(info.name) === "text" ? new TextDecoder("utf-8", { fatal: true }) : undefined;
  let invalidText: Error | undefined;
  const checkText = (value?: Buffer) => {
    if (!decoder || invalidText) return;
    try {
      if (decoder.decode(value, { stream: !!value }).includes("\0"))
        invalidText = new Error("原件包含二进制内容，不能当作文本发送");
    } catch (error) { invalidText = new Error("原件不是可读取的 UTF-8 文本", { cause: error }); }
  };
  try {
    await pipeline(req, async function* (chunks) {
      for await (const chunk of chunks) {
        length += chunk.length;
        if (length > size) throw new Error("实际材料大小超过声明值");
        checkText(chunk);
        digest.update(chunk);
        yield chunk;
      }
    }, createWriteStream(path, { flags: "wx" }));
    if (!req.complete || length !== size) throw new Error("材料未完整接收");
    checkText();
    if (invalidText) throw invalidText;
    if (info.mode === "excerpt") await readMobileExcerpt(path);
    return { dir, path, length, hash: digest.digest("hex") };
  } catch (error) {
    await discardMobileMaterial({ dir, path });
    throw error;
  }
}

export async function discardMobileMaterial(file: Pick<Staged, "dir" | "path">) {
  await unlink(file.path).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  await rmdir(file.dir).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
}
