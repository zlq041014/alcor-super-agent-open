import { spawn } from "node:child_process";
import { lstat, stat, readFile, mkdir, writeFile } from "node:fs/promises";
import {
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { safeArgv } from "../core/check-policy";
import type { CheckInput, CheckRun } from "../shared/loop-contracts";
import { childEnv, hash, redact, within } from "./security";
import { sensitive } from "./native-work";
import { windowsCheckMonitor } from "./windows-check";

const windows = process.platform === "win32";
const headSize = 20 * 1024,
  tailSize = 60 * 1024;
const unavailable = (e: unknown) =>
  ["ENOENT", "ENOTDIR", "EACCES"].includes(
    (e as NodeJS.ErrnoException).code || "",
  );
const missingDependency =
  /missing script|script [^\r\n]+ not found|command not found|is not recognized as an internal or external command|cannot find module|module_not_found|no module named|no matching package named|no package found in cache|no go\.mod file/i;

export type CheckExecution = {
  state: "ended" | "unknown";
  outcome?: CheckRun["outcome"];
  exitCode?: number;
  output: string;
  durationMs: number;
};

function checkEnv(paths: string[]) {
  const env = childEnv();
  const path = env.Path || env.PATH || "";
  delete env.Path;
  delete env.CODEX_HOME;
  return {
    ...env,
    PATH: [path, ...paths].filter(Boolean).join(delimiter),
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    npm_config_offline: "true",
    COREPACK_ENABLE_NETWORK: "0",
    YARN_ENABLE_NETWORK: "0",
    CARGO_NET_OFFLINE: "true",
    GOPROXY: "off",
    GOSUMDB: "off",
    GOTOOLCHAIN: "local",
  };
}

async function findProgram(name: string, path: string, pathext?: string) {
  const extensions = windows
    ? extname(name)
      ? [""]
      : (pathext || ".EXE;.CMD;.BAT")
          .split(";")
          .filter((ext) => /^\.(?:exe|cmd|bat)$/i.test(ext))
    : [""];
  for (const entry of path.split(delimiter)) {
    const dir = entry.replace(/^"(.*)"$/, "$1");
    if (!isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const file = join(dir, name + ext);
      if (windows && !/\.(exe|cmd|bat)$/i.test(file)) continue;
      const st = await stat(file).catch((e) => {
        if (unavailable(e)) return undefined;
        throw e;
      });
      if (st?.isFile() && (windows || st.mode & 0o111)) return file;
    }
  }
}

export function checkPidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((e as NodeJS.ErrnoException).code === "EPERM") return true;
    throw e;
  }
}

export async function runCheck(
  input: CheckInput,
  options: {
    root: string;
    checkPath: string[];
    timeoutMs: number;
    signal?: AbortSignal;
    started?: (pid: number) => void;
  },
): Promise<CheckExecution> {
  const start = Date.now();
  const result = (
    outcome: CheckRun["outcome"],
    output: string,
    exitCode?: number,
  ): CheckExecution => ({
    state: "ended",
    outcome,
    output: redact(output),
    exitCode,
    durationMs: Date.now() - start,
  });
  if (options.signal?.aborted) return result(undefined, "检查已停止");
  if (input.kind === "file") {
    if (sensitive(input.path)) return result("environment", "不能检查凭据文件");
    try {
      const path = await within(
        options.root,
        resolve(options.root, input.path),
      );
      const named = resolve(options.root, input.path);
      const st = await lstat(named);
      if (
        sensitive(relative(options.root, path)) ||
        path.toLowerCase() !== named.toLowerCase() ||
        !st.isFile() ||
        st.nlink > 1 ||
        st.size > 2 * 1024 * 1024
      )
        return result(
          "environment",
          "文件检查只支持项目内 2 MB 以下的普通文件，不沿用链接",
        );
      if (!input.contains) return result("passed", "已确认文件存在");
      const ok = (await readFile(path, "utf8")).includes(input.contains);
      return result(
        ok ? "passed" : "failed",
        ok ? "文件包含约定文本" : "文件缺少约定文本",
      );
    } catch (e) {
      if (
        ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code || "")
      )
        return result("failed", "文件不存在");
      return result("environment", (e as Error).message);
    }
  }
  if (!safeArgv(input))
    return result("environment", "参数或程序名含不允许的字符");
  const env = checkEnv(options.checkPath);
  let cwd: string, program: string | undefined;
  try {
    cwd = await within(options.root, resolve(options.root, input.cwd));
    program = await findProgram(
      input.program,
      env.PATH,
      (env as NodeJS.ProcessEnv).PATHEXT,
    );
  } catch (e) {
    return result("environment", (e as Error).message);
  }
  if (!program)
    return result("environment", "PATH 中找不到检查程序：" + input.program);
  const viaCmd = windows && /\.(cmd|bat)$/i.test(program);
  if (viaCmd && /[%!"\r\n]/.test(program))
    return result("environment", "批处理入口路径含不允许的字符");
  const system32 = join(process.env.SystemRoot || "C:\\Windows", "System32");
  const command = viaCmd ? join(system32, "cmd.exe") : program;
  const argv =
    /^dotnet(?:\.exe|\.cmd|\.bat)?$/i.test(input.program) &&
    ["build", "test"].includes(input.args[0]) &&
    !input.args.includes("--no-restore")
      ? [...input.args, "--no-restore"]
      : input.args;
  const args = viaCmd
    ? [
        "/d",
        "/s",
        "/v:off",
        "/c",
        '""' + program + '"' + (argv.length ? " " + argv.join(" ") : "") + '"',
      ]
    : argv;
  if (options.signal?.aborted) return result(undefined, "检查已停止");
  return new Promise((done, fail) => {
    const child = windows
      ? spawn(
          join(system32, "WindowsPowerShell/v1.0/powershell.exe"),
          [
            "-NoProfile",
            "-NonInteractive",
            "-OutputFormat",
            "Text",
            "-EncodedCommand",
            windowsCheckMonitor,
          ],
          {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"],
          },
        )
      : spawn(command, args, {
          cwd,
          env,
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
    let head = Buffer.alloc(0),
      tail = Buffer.alloc(0),
      total = 0;
    let stopped: "timeout" | "cancel" | undefined,
      settled = false;
    let termination: NodeJS.Timeout | undefined, ledgerError: unknown;
    const collect = (bytes: Buffer) => {
      total += bytes.length;
      const cut = Math.min(headSize - head.length, bytes.length);
      if (cut) head = Buffer.concat([head, bytes.subarray(0, cut)]);
      const remainder = bytes.subarray(cut);
      if (remainder.length) {
        const extra = tail.length + remainder.length - tailSize;
        tail =
          remainder.length >= tailSize
            ? Buffer.from(remainder.subarray(-tailSize))
            : Buffer.concat([tail.subarray(Math.max(0, extra)), remainder]);
      }
    };
    const output = () =>
      head.toString() +
      (total > headSize + tailSize ? "\n… 已截断 …\n" : "") +
      tail.toString();
    const finish = (value: CheckExecution) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(termination);
      options.signal?.removeEventListener("abort", cancel);
      if (ledgerError) fail(ledgerError);
      else done(value);
    };
    const stop = (reason: "timeout" | "cancel") => {
      if (stopped || settled) return;
      stopped = reason;
      if (windows) child.stdin.end();
      else if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH")
            collect(Buffer.from("\n进程树终止失败：" + (e as Error).message));
        }
      }
      termination = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish({
          ...result(undefined, output() + "\n未确认检查进程已退出"),
          state: "unknown",
        });
      }, 5000);
    };
    const cancel = () => stop("cancel");
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", (e) =>
      collect(Buffer.from("\n检查监护器管道：" + e.message)),
    );
    child.once("error", (e) => finish(result("environment", e.message)));
    child.once("close", (code) => {
      const text = output();
      const outcome =
        stopped === "timeout"
          ? "timeout"
          : stopped === "cancel"
            ? undefined
            : code === 0
              ? "passed"
              : code === 9009 ||
                  code === 9010 ||
                  missingDependency.test(text) ||
                  code === null
                ? "environment"
                : "failed";
      finish(result(outcome, text, code ?? undefined));
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (child.pid) options.started?.(child.pid);
    } catch (e) {
      ledgerError = e;
      cancel();
    }
    if (options.signal?.aborted) cancel();
    if (!stopped && child.pid) {
      if (windows)
        child.stdin.write(
          JSON.stringify({ file: command, args: args.join(" ") }) + "\n",
        );
      else child.stdin.end();
    }
  });
}

export function failureSignature(output: string) {
  return hash(
    output
      .slice(-12000)
      .replace(
        /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/g,
        "<time>",
      )
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|seconds?|secs?|s)\b/gi, "<duration>")
      .replace(/(?:[A-Z]:[\\/]|\/(?=[^\s/]))[^\s"'<>]*/gi, "<path>")
      .replace(/\b0x[0-9a-f]+\b/gi, "<address>"),
  );
}

export async function checkOutputBlob(
  dataDir: string,
  output: string | Buffer,
) {
  const id = hash(output);
  const dir = join(dataDir, "blobs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, id), output, { flag: "wx" }).catch((e) => {
    if (e.code !== "EEXIST") throw e;
  });
  return id;
}
