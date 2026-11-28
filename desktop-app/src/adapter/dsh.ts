import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { access, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  apiTarget,
  EffortSchema,
  ProfileSchema,
  type ModelEntry,
  type ModelProfile,
  type Settings,
} from "../shared/contracts";
import { childEnv } from "../hub/security";
import { RpcError } from "./codex";
import { dshModelRoute } from "./dsh-model";
import type { WorkspaceOptions } from "./dsh-files";

const exec = promisify(execFile);
const supported = "0.2.2-rc.5",
  provider = "alcor-api";
export async function dshInstallation(configured: string) {
  const candidates = configured
    ? [configured]
    : [
        "D:\\dsh_desktop\\DeepSeek Harness.exe",
        ...[
          process.env.LOCALAPPDATA &&
            join(process.env.LOCALAPPDATA, "Programs"),
          process.env.ProgramFiles,
        ]
          .filter((x): x is string => !!x)
          .map((p) => join(p, "DeepSeek Harness", "DeepSeek Harness.exe")),
      ];
  for (const path of candidates) {
    if (
      !isAbsolute(path) ||
      basename(path).toLowerCase() !== "deepseek harness.exe"
    )
      continue;
    try {
      await access(path);
      // Electron presents an ASAR root as a virtual directory; fs.access on
      // its root reports ENOENT although fs.stat and the official CLI can open it.
      await stat(join(dirname(path), "resources", "app.asar"));
    } catch {
      continue;
    }
    // Same entry point and arguments as the installed runtime/cli/bin/dsh.cmd, without a shell.
    const args = [
      "--expose-internals",
      join(
        dirname(path),
        "resources",
        "app.asar",
        "dsh",
        "node_modules",
        "@deepseek-ai",
        "dsh-desktop-host",
        "lib",
        "cli.js",
      ),
    ];
    const env = { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" };
    delete (env as Record<string, string>).CODEX_HOME;
    let version: string;
    try {
      version = (
        await exec(path, [...args, "--version"], {
          env,
          timeout: 10000,
          windowsHide: true,
        })
      ).stdout.trim();
    } catch {
      throw new Error("无法启动 DSH CLI，请检查 DeepSeek Harness 安装目录");
    }
    if (version !== supported)
      throw new Error("DSH 版本不匹配；此连接器已验证 " + supported);
    return { path, args, env, version };
  }
  throw new Error(
    "未找到 DeepSeek Harness，请在设置中指定 DeepSeek Harness.exe",
  );
}

export const dshModelInput = (cfg: Settings, profile: ModelProfile) =>
  cfg.apiSource === "custom" && profile.model === "deepseek-flash" ? ["text", "image"] : ["text"];

function overlay(endpoint: string, cfg: Settings, profile: ModelProfile, nativeTools: boolean, candidates = [profile.model]) {
  const choice = { provider, model: profile.model };
  const responses = apiTarget(cfg).protocol === "responses";
  const efforts = (model: string) => cfg.apiSource === "deepseek" ? ["low", "high", "max"] : model.startsWith("deepseek-")
    ? ["low", "medium", "high", "max"] : ["minimal", "low", "medium", "high", "xhigh", "max"];
  return JSON.stringify([
    { id: "agent-default-model", config: choice },
    { id: "acp", config: choice },
    {
      id: "llm-pi-ai",
      config: {
        providers: {
          [provider]: {
            apiKeyEnv: "ALCOR_DSH_ROUTE_TOKEN",
            api: responses ? "openai-responses" : "openai-completions",
            baseURL: endpoint,
            displayName: "Alcor API",
            models: candidates.map(model => ({
                id: model,
                name: model,
                input: dshModelInput(cfg, { ...profile, model }),
                reasoningEfforts: {
                  off: null,
                  ...Object.fromEntries(efforts(model).map((e) => [e, e])),
                },
            })),
            ...(!responses
              ? {
                  compat: {
                    supportsDeveloperRole: false,
                    supportsStore: false,
                    supportsReasoningEffort: true,
                    maxTokensField: "max_tokens",
                    ...(profile.model.startsWith("deepseek-")
                      ? {
                          thinkingFormat: "deepseek",
                          requiresReasoningContentOnAssistantMessages: true,
                        }
                      : {}),
                  },
                }
              : {}),
          },
        },
      },
    },
    // The original file-only work keeps its recorded boundary.
    ...(nativeTools ? [] : [
      "tool-fs",
      "tool-fs-search",
      "agent-instructions",
      "tool-working-directory",
      "tool-bash",
      "tool-pwsh",
      "tool-jobs",
      "tool-web",
      "tool-skill",
      "tool-agent-team",
      "tool-subagent",
      "tool-subagent-control",
      "tool-subagent-fork",
      "tool-workflow",
    ]).map((id) => ({ id, disabled: true })),
    ...[
      "session-log-deepseek",
      "session-telemetry-otel",
      "llm-deepseek",
      "llm-deepseek-account",
    ].map((id) => ({ id, disabled: true })),
  ]);
}

export function dshCatalogOptions(options: unknown, candidates: string[]): ModelEntry[] {
  if (!Array.isArray(options)) return [];
  const model = options.find(row => row?.id === "model" && row.type === "select");
  const groups: { group?: string; options?: unknown }[] = Array.isArray(model?.options) ? model.options : [];
  const group = groups.find(row => row?.group === provider);
  const allowed = new Set(candidates), entries = new Map<string, ModelEntry>();
  for (const choice of Array.isArray(group?.options) ? group.options : []) {
    if (typeof choice?.value !== "string") continue;
    let value: unknown;
    try { value = JSON.parse(choice.value); } catch { continue; }
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== provider || !allowed.has(value[1]) ||
        !ProfileSchema.shape.model.safeParse(value[1]).success) continue;
    const selected = choice.value === model.currentValue;
    const levels = selected ? options.find(row => row?.id === "reasoning_effort")?.options : undefined;
    const efforts: ModelEntry["efforts"] = [];
    for (const level of Array.isArray(levels) ? levels : []) {
      const effort = EffortSchema.safeParse(level?.value === "off" ? "none" : level?.value === "" ? "default" : level?.value);
      if (effort.success && !efforts.includes(effort.data)) efforts.push(effort.data);
    }
    entries.set(value[1], { id: value[1], efforts });
  }
  return [...entries.values()];
}

// A separate ACP process per run keeps sessions, requests, credentials and cancellations local.
class Acp {
  private seq = 0;
  private pending = new Map<
    number,
    { ok(v: any): void; fail(e: Error): void; timer?: NodeJS.Timeout }
  >();
  private closed = false;
  update?: (params: any) => void;
  constructor(private proc: ChildProcessWithoutNullStreams) {
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) return this.close();
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.close();
          break;
        }
      }
    });
    proc.stderr.resume(); // Native stderr and ACP error data may contain task text.
    proc.stdin.on("error", () => this.close());
    proc.on("error", () => this.close());
    proc.on("close", () => this.close());
  }
  send(message: any) {
    if (this.closed || !this.proc.stdin.writable)
      throw new RpcError("DSH ACP 已断开", true);
    this.proc.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n",
    );
  }
  private receive(m: any) {
    if (m.jsonrpc !== "2.0") throw new Error("invalid ACP envelope");
    if (m.method) {
      if (m.id != null) {
        if (m.method === "session/request_permission")
          this.send({
            id: m.id,
            result: { outcome: { outcome: "cancelled" } },
          });
        else
          this.send({
            id: m.id,
            error: { code: -32601, message: "Unsupported client capability" },
          });
      } else if (m.method === "session/update") this.update?.(m.params);
      return;
    }
    const request = this.pending.get(m.id);
    if (!request) return;
    this.pending.delete(m.id);
    clearTimeout(request.timer);
    if (m.error)
      request.fail(
        new RpcError(
          "DSH ACP 拒绝请求（" + (Number(m.error.code) || "未知") + "）",
        ),
      );
    else request.ok(m.result);
  }
  call(method: string, params: any, timeout: number | null = 30000): Promise<any> {
    const id = ++this.seq;
    return new Promise((ok, fail) => {
      const timer = timeout === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        fail(new RpcError("DSH ACP 等待回执超时", true));
      }, timeout);
      this.pending.set(id, { ok, fail, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        fail(e);
      }
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.fail(new RpcError("DSH ACP 连接中断，结果未知", true));
    }
    this.pending.clear();
    this.proc.kill();
  }
}

export async function openDsh(
  options: {
    dir: string;
    cwd: string;
    cfg: Settings;
    profile: ModelProfile;
    key?: string;
    resume?: string;
    native?: boolean;
    nativeGraph?: boolean;
    taskBudget?: boolean;
    catalogCandidates?: string[];
  } & WorkspaceOptions,
) {
  const { cfg, profile, dir, cwd } = options;
  if (options.catalogCandidates && (options.key || options.write || options.resume || options.native || options.nativeGraph))
    throw new Error("DSH 模型目录只从隔离只读会话读取");
  const install = await dshInstallation(cfg.dshPath);
  await mkdir(dir, { recursive: true });
  const patch = join(dir, randomUUID() + ".patch.yml");
  const route = options.key
    ? await dshModelRoute(cfg, profile, options.key, options)
    : undefined;
  let acp: Acp | undefined;
  let cancelWait: NodeJS.Timeout | undefined;
  const close = () => {
    clearTimeout(cancelWait);
    acp?.close();
    route?.close();
    void unlink(patch).catch(() => {});
  };
  try {
    await writeFile(
      patch,
      overlay(route?.endpoint || "http://127.0.0.1:1/v1", cfg, profile,
        options.native === true || options.nativeGraph === true, options.catalogCandidates),
      { flag: "wx" },
    );
    acp = new Acp(
      spawn(
        install.path,
        [...install.args, "--profile", "acp", "--patch", patch],
        {
          cwd,
          windowsHide: true,
          stdio: "pipe",
          env: {
            ...install.env,
            DSH_HOME: dir,
            DSH_TELEMETRY_DISABLED: "1",
            DSH_PERMISSION_MODE: options.native
              ? "danger-full-access"
              : options.write
                ? "workspace-write"
                : "read-only",
            ...(route ? { ALCOR_DSH_ROUTE_TOKEN: route.token }
              : options.catalogCandidates ? { ALCOR_DSH_ROUTE_TOKEN: "catalog-read-only" } : {}),
          },
        },
      ),
    );
    const hello = await acp.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    if (
      hello?.protocolVersion !== 1 ||
      hello.agentInfo?.name !== "deepseek-harness-acp"
    )
      throw new Error("DSH 未返回受支持的 ACP 握手");
    const resumed = options.resume;
    if (resumed && !hello.agentCapabilities?.sessionCapabilities?.resume)
      throw new Error("此 DSH 不支持续接受管会话");
    const session = await acp.call(resumed ? "session/resume" : "session/new", {
      cwd,
      mcpServers: route && !options.native ? [route.mcp] : [],
      ...(resumed ? { sessionId: resumed } : {}),
    });
    const id = resumed || session?.sessionId;
    if (typeof id !== "string" || !id || id.length > 200)
      throw new Error("DSH 没有返回有效的会话身份");
    const current = (opts: any, name: string) =>
      Array.isArray(opts)
        ? opts.find((e: any) => e.id === name)?.currentValue
        : undefined;
    const model = JSON.stringify([provider, profile.model]);
    let opts = session.configOptions;
    if (current(opts, "model") !== model) {
      opts = (
        await acp.call("session/set_config_option", {
          sessionId: id,
          configId: "model",
          value: model,
        })
      ).configOptions;
    }
    const effort = profile.effort === "none" ? "off" : profile.effort;
    if (effort !== "default" && current(opts, "reasoning_effort") !== effort) {
      opts = (
        await acp.call("session/set_config_option", {
          sessionId: id,
          configId: "reasoning_effort",
          value: effort,
        })
      ).configOptions;
    }
    if (
      current(opts, "model") !== model ||
      (effort !== "default" && current(opts, "reasoning_effort") !== effort)
    )
      throw new Error("DSH 没有确认指定的模型或思考强度，未发送任务");
    const client = acp;
    return {
      id,
      version: install.version,
      effort: current(opts, "reasoning_effort") as string | undefined,
      ...(options.catalogCandidates ? { models: dshCatalogOptions(opts, options.catalogCandidates) } : {}),
      usage: () =>
        route?.evidence.usage.requests
          ? { ...route.evidence.usage }
          : undefined,
      close,
      cancel() {
        route?.stopFiles();
        client.send({ method: "session/cancel", params: { sessionId: id } });
        // A missing cancellation receipt remains unknown; a healthy working turn has no such timer.
        cancelWait ??= setTimeout(close, 30000);
      },
      async prompt(text: string, onUpdate: (u: any) => void) {
        if (!route) throw new Error("检测会话不允许发送任务");
        client.update = (p) => {
          if (p?.sessionId === id) onUpdate(p.update);
        };
        const out = await client.call(
          "session/prompt",
          { sessionId: id, prompt: [{ type: "text", text }] },
          options.taskBudget ? null : (cfg.maxMinutes + 1) * 60000,
        );
        const usage = route.evidence.usage.requests
          ? { ...route.evidence.usage }
          : undefined;
        return {
          reason: out?.stopReason,
          error: route.evidence.error,
          accepted: route.evidence.accepted,
          ...(usage ? { usage } : {}),
        };
      },
    };
  } catch (e) {
    close();
    throw e;
  }
}
export type DshSession = Awaited<ReturnType<typeof openDsh>>;
