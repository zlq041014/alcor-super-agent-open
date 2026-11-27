import { spawn } from "node:child_process";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { evaluateWindow, startWindow } from "../core/graph-progress";
import { pathKey } from "../core/glob";
import { PreviewJobDefinition, PreviewReceipt, PreviewStop, previewTerminal } from "../shared/preview-job";
import { childEnv, hash } from "./security";
import { windowsPreviewGuard } from "./windows-preview-guard";

function windowsArgument(value: string) {
  // CreateProcess uses the Windows CRT quoting rules, without a shell.
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1") + '"';
}

export function startGuardedPreview(file: string, args: string[], cwd: string, hardAt: number) {
  if (process.platform !== "win32") throw new Error("预览进程监护只支持 Windows");
  const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
  const env = childEnv();
  delete env.CODEX_HOME;
  const child = spawn(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", windowsPreviewGuard,
  ], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let log = "", closed = false;
  let failed: Error | undefined;
  child.stdout.on("data", (part: Buffer) => { log = (log + part.toString("ascii")).slice(-512); });
  child.on("error", (error) => { failed = error; });
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") failed = error;
  });
  const done = new Promise<{ released: boolean; exitCode?: number; endedAt?: number }>((accept) => {
    child.on("close", () => {
      closed = true;
      const result = /(?:^|\r?\n)released (\d+) (\d+)(?:\r?\n|$)/.exec(log);
      accept(result && !failed ? {
        released: true, exitCode: Number(result[1]), endedAt: Number(result[2]),
      } : { released: false });
    });
  });
  child.stdin.write(JSON.stringify({ file, command: [file, ...args].map(windowsArgument).join(" "), cwd, hardAt }) + "\n");
  return {
    get started() { return /(?:^|\r?\n)started(?:\r?\n|$)/.test(log); },
    get closed() { return closed; },
    done,
    stop() { if (!child.stdin.writableEnded) child.stdin.end(); },
  };
}

export const previewFrameName = (i: number) => "frame-" + String(i).padStart(4, "0") + ".png";
const signature = Buffer.from("89504e470d0a1a0a", "hex");
const trailer = Buffer.from("0000000049454e44ae426082", "hex");
export const isCompletePreviewFrame = (data: Buffer) =>
  data.length >= 45 && data.length <= 2 * 1024 * 1024 &&
  data.subarray(0, signature.length).equals(signature) &&
  data.subarray(-trailer.length).equals(trailer);

export async function previewFrameCount(dir: string, limit: number, from = 0) {
  let valid = from;
  for (let frame = from + 1; frame <= limit; frame++) {
    const file = join(dir, previewFrameName(frame));
    try {
      const st = await lstat(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 45 || st.size > 2 * 1024 * 1024) break;
      const data = await readFile(file);
      if (!isCompletePreviewFrame(data)) break;
      valid = frame;
    } catch (error) {
      if (["ENOENT", "EBUSY", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) break;
      throw error;
    }
  }
  return valid;
}

function matches(definition: PreviewJobDefinition, token: { id: string; receiptKey: string }) {
  return token.id === definition.id && token.receiptKey === definition.receiptKey;
}

export async function readPreviewReceipt(dir: string, definition: PreviewJobDefinition) {
  try {
    const result = PreviewReceipt.safeParse(JSON.parse(await readFile(join(dir, "receipt.json"), "utf8")));
    if (result.success && matches(definition, result.data) &&
        result.data.frames <= definition.frames &&
        (!previewTerminal(result.data.phase) || result.data.phase !== "completed" || result.data.frames === definition.frames))
      return result.data;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function requestPreviewStop(dir: string, definition: PreviewJobDefinition, reason: PreviewStop["reason"]) {
  const path = join(dir, "stop.json");
  const request = { id: definition.id, receiptKey: definition.receiptKey, reason };
  try {
    await writeFile(path, JSON.stringify(request), { flag: "wx", flush: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = PreviewStop.parse(JSON.parse(await readFile(path, "utf8")));
    if (!matches(definition, prior)) throw new Error("原停止请求与本作业不匹配");
  }
}

async function stopReason(dir: string, definition: PreviewJobDefinition) {
  try {
    const parsed = PreviewStop.safeParse(JSON.parse(await readFile(join(dir, "stop.json"), "utf8")));
    if (parsed.success && matches(definition, parsed.data)) return parsed.data.reason;
  } catch (error) {
    // The caller may be between creating the request and completing the write.
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function previewArguments(input: string, expected: number) {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-protocol_whitelist", "file",
    "-f", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", input,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "fps=2,scale=320:-2",
    "-threads", "1", "-frames:v", String(expected), "-f", "image2", "frame-%04d.png",
  ];
}

export async function runPreviewMonitor(dir: string, definition: PreviewJobDefinition) {
  if (!isAbsolute(dir) || pathKey(await realpath(dir)) !== pathKey(resolve(dir)) || basename(dir) !== definition.id)
    throw new Error("预览目录与作业编号不匹配");
  // A second monitor never opens the same writer or replaces its receipt.
  await writeFile(join(dir, "claimed"), definition.receiptKey, { flag: "wx", flush: true });
  let sequence = 0, frames = 0;
  let window = definition.intervalMs ? startWindow(Date.now(), definition.intervalMs, definition.hardAt) : undefined;
  const save = async (phase: PreviewReceipt["phase"], reason?: PreviewReceipt["reason"]) => {
    const receipt: PreviewReceipt = {
      id: definition.id, receiptKey: definition.receiptKey, sequence: ++sequence,
      at: Date.now(), phase, frames, ...(window && { observeAt: window.observeAt }), reason,
    };
    const pending = join(dir, "receipt.new"), target = join(dir, "receipt.json");
    await writeFile(pending, JSON.stringify(receipt), { flag: "wx", flush: previewTerminal(phase) });
    await rename(pending, target);
  };
  await save("preparing");
  const input = join(dir, "source.mp4");
  try {
    if (!isAbsolute(definition.ffmpeg) || basename(definition.ffmpeg).toLowerCase() !== "ffmpeg.exe" ||
        pathKey(await realpath(definition.ffmpeg)) !== pathKey(resolve(definition.ffmpeg)))
      throw new Error("FFmpeg 入口无效");
    const stat = await lstat(input);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 20 * 1024 * 1024)
      throw new Error("输入不是受支持的普通 MP4 文件");
    const bytes = await readFile(input);
    if (bytes.subarray(4, 8).toString() !== "ftyp" || hash(bytes) !== definition.sourceHash)
      throw new Error("视频与授权版本不匹配");
  } catch {
    await save("failed", "input");
    return;
  }
  let stop = Date.now() >= definition.hardAt ? "hard" as const : await stopReason(dir, definition);
  if (stop) {
    await save("stopped", stop);
    return;
  }
  const guard = startGuardedPreview(definition.ffmpeg, previewArguments(input, definition.frames), dir, definition.hardAt);
  try {
    do {
      frames = await previewFrameCount(dir, definition.frames, frames);
      const now = Date.now();
      stop ??= now >= definition.hardAt ? "hard" : await stopReason(dir, definition);
      if (!stop && window) {
        const decision = evaluateWindow(window, frames, now);
        if (decision.kind === "extend") window = decision.window;
        else if (decision.kind === "stop") stop = decision.reason;
      }
      if (stop) guard.stop();
      if (guard.closed) break;
      await save(stop ? "stopping" : guard.started ? "running" : "preparing", stop);
      await Promise.race([guard.done, delay(350)]);
    } while (!guard.closed);
    const result = await guard.done;
    if (!result.released) await save("unknown", "receipt");
    else if (result.endedAt! >= definition.hardAt) await save("stopped", "hard");
    else if (stop) await save("stopped", stop);
    else if (result.exitCode !== 0) await save("failed", "process");
    else {
      frames = await previewFrameCount(dir, definition.frames);
      await (frames === definition.frames ? save("completed") : save("failed", "frames"));
    }
  } finally {
    guard.stop();
  }
}

export async function readPreviewDefinition(path: string) {
  const dir = dirname(path);
  return { dir, definition: PreviewJobDefinition.parse(JSON.parse(await readFile(path, "utf8"))) };
}

export function launchPreviewMonitor(definitionPath: string, entry = join(__dirname, "hub-preview-job.cjs")) {
  return new Promise<number>((accept, reject) => {
    const env = childEnv();
    env.ELECTRON_RUN_AS_NODE = "1";
    delete env.CODEX_HOME;
    const child = spawn(process.execPath, [entry, definitionPath], {
      detached: true, windowsHide: true, stdio: "ignore", env,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      accept(child.pid!);
    });
  });
}
