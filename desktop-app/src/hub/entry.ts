import { Hub } from "./service";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { redact, Vault } from "./security";
import { apiTarget } from "../shared/contracts";
import { dshBridgeVault } from "../adapter/dsh-desktop";
import { canonicalDataDirectory } from "../data-directory";
import { MobileDesk } from "./mobile";

function startupFailure(error: string) {
  if (process.send && process.connected)
    process.send({ event: "fatal", error }, () => process.exit(2));
  else process.exit(2);
}

function startupDirectory(path: string) {
  try {
    return canonicalDataDirectory(path);
  } catch {
    startupFailure("无法打开指定数据目录，请检查路径和权限。");
  }
}

const dir = startupDirectory(process.argv[2]);
if (dir) start(dir);

function start(dir: string) {
  // The OS owns this exclusive pipe handle; a stale PID file is never an ownership proof.
  const lock = createServer((socket) => socket.destroy());
  const name =
    "\\\\.\\pipe\\alcor-hub-" +
    createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 24);
  lock.on("error", () => {
    startupFailure(
      "这个数据目录已有 Hub，或无法取得独占锁。请从原窗口打开星引。",
    );
  });
  lock.listen(name, () => {
    let hub: Hub;
    try {
      hub = new Hub(dir, undefined, process.argv[3]);
    } catch (error) {
      startupFailure("星引账本未打开：" + redact((error as Error).message));
      return;
    }
    hub.on("change", () => process.send?.({ event: "change" }));
    hub.on("result", (value) => process.send?.({ event: "result", value }));
    hub.on("fault", (error) => process.send?.({ event: "fatal", error }));
    const mobile = new MobileDesk(hub);
    let localWrites = 0;
    process.on("message", async (raw: any) => {
      if (!raw || typeof raw.id !== "string") return;
      const localWrite =
        raw.internal === "credential" || raw.internal === "attachment";
      if (localWrite) localWrites++;
      try {
        if (hub.restoring && raw.internal && raw.internal !== "shutdown")
          throw new Error("备份恢复进行中，完成后可继续操作");
        if (raw.internal === "restore" && localWrites)
          throw new Error("凭据或附件仍在保存，请稍后恢复备份");
        let value;
        switch (raw.internal) {
          case "credential": {
            const cfg = hub.settings();
            if (raw.dshDesktop === true) {
              if (!cfg.dshDesktopUrl || raw.endpoint !== cfg.dshDesktopUrl)
                throw new Error("DSH 原桌面桥地址已更换，请重新打开令牌窗口");
              await new Vault(dir, dshBridgeVault).save(raw.endpoint, raw.key);
              value = true;
              break;
            }
            if (
              raw.native
                ? raw.endpoint !== `codex:${cfg.codexCredentialEnv}`
                : raw.source !== cfg.apiSource ||
                  raw.endpoint !== apiTarget(cfg).endpoint
            )
              throw new Error("凭据目标已更换，请重新打开密钥设置");
            if (raw.native) {
              if (hub.store.all("run").some((r) => r.state !== "ended"))
                throw new Error("请先停止并核对活动执行，再更换原生凭据");
              if (hub.codex.initialized) await hub.codex.stop();
            }
            await (
              raw.native
                ? new Vault(dir, "codex-native.dpapi")
                : hub.brain.vaultFor(cfg)
            ).save(raw.endpoint, raw.key);
            if (raw.native) {
              hub.store.remove("native-models", "global");
              hub.executorCatalog.clear("codex");
            } else {
              hub.store.remove("models", "global");
              hub.executorCatalog.clear("dsh");
            }
            value = true;
            break;
          }
          case "attachment":
            value = await hub.addAttachment(raw.path);
            break;
          case "restore":
            value = await hub.restore(raw.path);
            break;
          case "claim-result-notice":
            value = hub.claimResultNotice(raw.notice);
            break;
          case "mobile":
            value = await mobile.local(raw.input);
            break;
          case "shutdown":
            await mobile.close();
            await hub.shutdown();
            value = true;
            break;
          default:
            value = await hub.request(raw.request);
        }
        if (raw.internal === "shutdown") {
          hub.store.close();
          lock.close();
          process.send!({ id: raw.id, ok: true, value }, (error) =>
            process.exit(error ? 1 : 0),
          );
          return;
        }
        process.send?.({ id: raw.id, ok: true, value });
      } catch (e) {
        process.send?.({
          id: raw.id,
          ok: false,
          error:
            (e as Error).name === "ZodError"
              ? "请求参数不符合当前接口契约"
              : (e as Error).message,
        });
      } finally {
        if (localWrite) localWrites--;
      }
    });
    process.on("disconnect", async () => {
      await mobile.close();
      await hub.shutdown();
      hub.store.close();
      process.exit(0);
    });
    process.on("uncaughtException", () => {
      process.send?.({
        event: "fatal",
        error: "Hub 意外中止；请重启并核对未完成工作",
      });
      process.exit(1);
    });
    hub.start();
    void mobile.startSaved().catch((error) => { mobile.error = redact((error as Error).message); });
    process.send?.({ event: "ready" });
  });
}
