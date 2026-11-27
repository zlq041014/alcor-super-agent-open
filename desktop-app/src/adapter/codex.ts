import { spawn, execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { childEnv } from "../hub/security";
import { APP_VERSION, CODEX_CLI_VERSIONS } from "../shared/contracts";

const exec = promisify(execFile);
export class RpcError extends Error {
  constructor(
    message: string,
    public uncertain = false,
    public code?: number,
  ) {
    super(message);
  }
}
export class Codex extends EventEmitter {
  process?: ReturnType<typeof spawn>;
  pending = new Map<
    string,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
      mutation: boolean;
    }
  >();
  sequence = 0;
  initialized = false;
  version = "";
  constructor(private home?: string) {
    super();
  }
  async connect(path: string, credential?: { name: string; value: string }) {
    if (this.initialized) return;
    if (!path || !path.toLowerCase().endsWith(".exe"))
      throw new Error("请选择 Codex CLI 的 .exe 程序");
    const env = childEnv();
    if (this.home) env.CODEX_HOME = this.home;
    const v = await exec(path, ["--version"], {
      windowsHide: true,
      timeout: 10000,
      env,
    });
    this.version = v.stdout.trim();
    // A version match enables the adapter, not a claim of sandbox or account verification.
    if (!CODEX_CLI_VERSIONS.some((version) => this.version === "codex-cli " + version))
      throw new Error(
        "当前连接器支持 Codex CLI " + CODEX_CLI_VERSIONS.join("、") + "；请使用匹配的版本",
      );
    if (credential) {
      if (!/^[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN)$/.test(credential.name))
        throw new Error("原生凭据变量名无效");
      env[credential.name] = credential.value;
    }
    const p = spawn(path, ["app-server", "--listen", "stdio://"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    this.process = p;
    let buffer = "";
    const decoder = new StringDecoder("utf8");
    p.stdout!.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) {
        p.kill();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          this.receive(JSON.parse(line));
        } catch {
          this.emit("protocolError");
        }
      }
    });
    p.stderr!.on("data", () => {}); // Native stderr may contain task content and credentials.
    p.on("error", () => this.disconnect());
    p.on("close", () => this.disconnect());
    const hello = await this.call(
      "initialize",
      {
        clientInfo: {
          name: "alcor-desktop",
          title: "星引 Alcor",
          version: APP_VERSION,
        },
        capabilities: { experimentalApi: true },
      },
      false,
    );
    this.send({ method: "initialized" });
    this.initialized = true;
    return hello;
  }
  send(value: any) {
    if (!this.process?.stdin?.writable) throw new RpcError("Codex 连接已断开");
    this.process.stdin.write(JSON.stringify(value) + "\n");
  }
  call(
    method: string,
    params: any,
    mutation = false,
    timeout = 30000,
  ): Promise<any> {
    const id = `alcor-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new RpcError(
            mutation
              ? "操作回执超时，结果未知；请先核对，勿重复执行"
              : "Codex 请求超时",
            mutation,
          ),
        );
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, mutation });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  receive(message: any) {
    if (!message || typeof message !== "object") return;
    if (message.method) {
      if (message.id !== undefined) this.emit("request", message);
      else this.emit("event", message);
      return;
    }
    const pending = this.pending.get(String(message.id));
    if (!pending) return;
    this.pending.delete(String(message.id));
    clearTimeout(pending.timer);
    if (message.error)
      pending.reject(
        new RpcError(
          `Codex 拒绝请求（${message.error.code ?? "未知代码"}）`,
          false,
          message.error.code,
        ),
      );
    else pending.resolve(message.result);
  }
  reply(id: string | number, result: any) {
    this.send({ id, result });
  }
  disconnect() {
    this.initialized = false;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RpcError("Codex 连接中断，执行状态需要对账", p.mutation));
    }
    this.pending.clear();
    this.emit("disconnect");
  }
  async stop() {
    const p = this.process;
    if (!p || p.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => p.kill(), 2000);
      p.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      p.stdin?.end();
    });
  }
}
