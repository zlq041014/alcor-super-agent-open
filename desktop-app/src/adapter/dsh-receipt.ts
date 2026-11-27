import { lstat, opendir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { zstdDecompress } from "node:zlib";
import { hash, within } from "../hub/security";
import { DshEndReason } from "../shared/contracts";

const decompress = promisify(zstdDecompress);
// ACP end_turn can also mean an upstream error. Inspect only the Alcor-owned
// v4 session, matching cwd, session id, the exact sent prompt and native turn.
export async function dshReceipt(
  home: string,
  cwd: string,
  id: string,
  payloadHash: string,
) {
  if (!/^[a-f0-9-]{36}$/i.test(id) || !/^[a-f0-9]{64}$/.test(payloadHash))
    return;
  try {
    const root = await within(home, join(home, "sessions"));
    const groups = await opendir(root);
    let count = 0;
    for await (const group of groups) {
      if (++count > 128) return;
      if (!group.isDirectory()) continue;
      const path = join(root, group.name, id, "session.v4.jsonl.zstd");
      const stat = await lstat(path).catch(() => null);
      if (!stat?.isFile() || stat.size > 8 * 1024 * 1024) continue;
      const packed = await readFile(await within(root, path));
      const data = await decompress(packed, {
        maxOutputLength: 32 * 1024 * 1024,
      });
      const [header, ...lines] = data.toString("utf8").trimEnd().split("\n");
      const meta = JSON.parse(header);
      if (
        meta.version !== 4 ||
        meta.type !== "session" ||
        meta.id !== id ||
        resolve(meta.cwd).toLowerCase() !== resolve(cwd).toLowerCase()
      )
        return;
      let turn: number | undefined,
        matched = false,
        answer = "";
      for (const line of lines) {
        const { type, data: d } = JSON.parse(line);
        if (type === "turn/start") {
          turn = d.turn;
          matched = false;
          answer = "";
        }
        if (
          type === "user/message" &&
          d.source?.kind === "user" &&
          d.content?.length === 1 &&
          d.content[0].type === "text" &&
          typeof d.content[0].text === "string"
        )
          matched = hash(d.content[0].text) === payloadHash;
        if (!matched || !Number.isInteger(turn) || d?.turn !== turn) continue;
        if (type === "assistant/message")
          answer = (d.message?.content || [])
            .filter((b: any) => b.type === "text" && typeof b.text === "string")
            .map((b: any) => b.text)
            .join("\n");
        if (type === "turn/end") {
          const parsed = DshEndReason.safeParse(d.reason?.kind);
          if (!parsed.success) return;
          const kind = parsed.data;
          return {
            status:
              kind === "completed" && answer.trim()
                ? "completed"
                : kind === "interrupted" || kind === "aborted"
                  ? "interrupted"
                  : "failed",
            answer,
            nativeEndReason: kind,
          };
        }
      }
    }
  } catch {
    /* Missing, torn or newer evidence is never a terminal receipt. */
  }
}
