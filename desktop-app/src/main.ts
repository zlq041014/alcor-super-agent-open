import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage,
  Notification,
} from "electron";
import { fork, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  apiTarget,
  Request,
  type Settings,
  type Snapshot,
} from "./shared/contracts";
import { childEnv, redact } from "./hub/security";
import { browseProjects, everythingAvailable } from "./everything";
import { desktopDataDirectory, saveDesktopDataDirectory } from "./data-directory";

const bootstrap = process.env.ALCOR_BOOTSTRAP_DIR || "D:\\data\\alcor\\desktop";
const dataDir = (() => {
  try {
    return desktopDataDirectory(bootstrap, process.env.ALCOR_DATA_DIR);
  } catch (error) {
    dialog.showErrorBox("星引无法打开数据目录", (error as Error).message);
    process.exit(1);
  }
})();
app.setPath("userData", join(dataDir, "shell"));
app.setAppUserModelId("com.alcor.desktop");
let window: BrowserWindow | undefined,
  credentials: BrowserWindow | undefined,
  tray: Tray | undefined;
let quitting = false,
  ready = false,
  closeBusy = false,
  hub: ReturnType<typeof fork>,
  last: Snapshot | undefined;
let hubFailure: string | undefined;
let credentialTarget:
  | { native: boolean; dshDesktop: boolean; source: Settings["apiSource"]; endpoint: string }
  | undefined;
const pending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
const appPage = join(__dirname, "index.html");
function rpc(value: any): Promise<any> {
  if (!hub?.connected)
    return Promise.reject(new Error(hubFailure || "Hub 不可用，请重新启动星引以恢复账本"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        pending.delete(id);
        reject(new Error("操作响应超时，请刷新核对，勿重复执行"));
      },
      [
        "chat",
        "project.progress",
        "project.use",
        "agent.choose",
        "agent.send",
      ].includes(value.request?.op)
        ? 300000
        : 120000,
    );
    pending.set(id, { resolve, reject, timer });
    hub.send({ id, ...value }, (error) => {
      if (!error || !pending.delete(id)) return;
      clearTimeout(timer);
      reject(new Error("Hub 连接中断，操作结果需要核对", { cause: error }));
    });
  });
}
function trusted(event: Electron.IpcMainInvokeEvent, secret = false) {
  const expected = secret ? credentials : window;
  if (
    !expected ||
    event.sender !== expected.webContents ||
    event.senderFrame !== expected.webContents.mainFrame
  )
    throw new Error("请求来源无效");
}
function secureWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_, __, cb) => cb(false));
}
function createWindow() {
  if (window) {
    window.show();
    return;
  }
  window = new BrowserWindow({
    title: "星引 Alcor",
    icon: join(__dirname, "alcor.png"),
    width: 1440,
    height: 940,
    minWidth: 940,
    minHeight: 660,
    backgroundColor: "#f6f7fb",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  secureWindow(window);
  void window.loadFile(appPage);
  window.once("ready-to-show", () => {
    window?.show();
    if (ready) window?.webContents.send("alcor.changed");
  });
  window.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    void onClose();
  });
  window.on("closed", () => {
    window = undefined;
  });
}
async function onClose() {
  if (closeBusy) return;
  closeBusy = true;
  try {
    last = await rpc({ request: { op: "snapshot" } });
    if (last?.settings.background) {
      window?.hide();
      return;
    }
    const active = last?.runs.some((r) => r.state !== "ended") ||
      last?.loops.some((loop) =>
        loop.phase !== "closed" && loop.phase !== "halted" &&
        last!.tasks.some((t)=>t.id===loop.taskId && t.state!=="paused" && t.state!=="cancelled"),
      );
    if (active) {
      const answer = await dialog.showMessageBox(window!, {
        type: "question",
        title: "退出星引",
        message: "仍有活动或状态未知的工作",
        detail:
          "停止并退出会保存暂停意图和实际停止结果。已有文件修改不会回滚；无法确认的回合会在下次启动时提示核对。",
        buttons: ["继续使用", "停止并退出", "保留后台运行"],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 0) return;
      if (answer.response === 2) {
        window?.hide();
        return;
      }
    }
    await shutdown();
  } catch {
    await shutdown();
  } finally {
    closeBusy = false;
  }
}
async function shutdown() {
  if (quitting) return;
  quitting = true;
  try {
    await rpc({ internal: "shutdown" });
  } catch {}
  app.quit();
}
async function discoverCodex() {
  try {
    const result = await promisify(execFile)(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(Get-Process codex -ErrorAction SilentlyContinue | Where-Object {$_.Path} | Select-Object -First 1 -ExpandProperty Path)",
      ],
      { windowsHide: true, timeout: 10000 },
    );
    const path = result.stdout.trim();
    if (path && existsSync(path)) return path;
  } catch {}
  return "";
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    createWindow();
    window?.focus();
  });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    createWindow();
    const fileFinder = app.isPackaged
      ? join(process.resourcesPath, "fd", "fd.exe")
      : join(app.getAppPath(), "tools", "fd", "fd.exe");
    hub = fork(join(__dirname, "hub-entry.cjs"), [dataDir, fileFinder], {
      execPath: process.execPath,
      env: { ...childEnv(), ELECTRON_RUN_AS_NODE: "1" },
      windowsHide: true,
      silent: true,
    });
    hub.stdout?.on("data", () => {});
    hub.stderr?.on("data", () => {});
    const onHubMessage = async (m: any) => {
      if (m.id) {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        m.ok ? p.resolve(m.value) : p.reject(new Error(m.error));
        return;
      }
      if (m.event === "ready") {
        hubFailure = undefined;
        ready = true;
        last = await rpc({ request: { op: "snapshot" } });
        if (!last!.settings.codexPath) {
          const path = await discoverCodex();
          const current: Snapshot = await rpc({ request: { op: "snapshot" } });
          if (path && !current.settings.codexPath)
            await rpc({
              request: {
                op: "settings",
                value: { ...current.settings, codexPath: path },
              },
            });
        }
        window?.webContents.send("alcor.changed");
      }
      if (m.event === "change") window?.webContents.send("alcor.changed");
      if (m.event === "fatal") {
        hubFailure = m.error;
        window?.webContents.send("alcor.error", hubFailure);
      }
      if (m.event === "result" && !quitting && Notification.isSupported()) {
        const notice = await rpc({ internal: "claim-result-notice", notice: m.value });
        if (notice && !quitting)
          new Notification({
            title: "星引 · 工作有新结果",
            body: notice.title,
          }).show();
      }
    };
    hub.on("message", (m) => {
      void onHubMessage(m).catch((error: Error) => {
        if (!quitting && hub.connected)
          window?.webContents.send("alcor.error", "Hub 状态读取失败：" + redact(error.message));
      });
    });
    hub.once("disconnect", () => {
      ready = false;
      hubFailure ??= "Hub 已退出；账本已保留。请完整退出后重开，核对未完成工作。";
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(hubFailure));
      }
      pending.clear();
      if (!quitting) window?.webContents.send("alcor.error", hubFailure);
    });
    const icon = nativeImage
      .createFromPath(join(__dirname, "alcor.png"))
      .resize({ width: 24, height: 24 });
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    tray.setToolTip("星引 Alcor");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开星引", click: createWindow },
        { label: "停止任务并退出", click: () => void shutdown() },
      ]),
    );
    tray.on("double-click", createWindow);
  });
}
ipcMain.handle("alcor.request", async (e, input) => {
  trusted(e);
  if (!ready) throw new Error(hubFailure || "Hub 正在启动，请稍候");
  const request = Request.parse(input);
  return rpc({ request });
});
ipcMain.handle("alcor.mobile", async (e, input) => {
  trusted(e);
  if (!ready) throw new Error(hubFailure || "Hub 正在启动，请稍候");
  return rpc({ internal: "mobile", input });
});
ipcMain.handle("alcor.openProject", async (e, id) => {
  trusted(e);
  const path = await rpc({
    request: Request.parse({ op: "project.directory", id }),
  });
  if (await shell.openPath(path))
    throw new Error("无法在资源管理器中打开项目目录");
});
ipcMain.handle("alcor.everything", async (e, action) => {
  trusted(e);
  if (action === "status") return everythingAvailable();
  if (action !== "browse") throw new Error("未知操作");
  return browseProjects(
    dataDir,
    await rpc({ request: { op: "projects.fileList" } }),
  );
});
ipcMain.handle("alcor.directory", async (e, purpose) => {
  trusted(e);
  const r = await dialog.showOpenDialog(window!, {
    title:
      purpose === "root"
        ? "选择常用项目的父目录（只查找直属文件夹）"
        : purpose === "parent"
          ? "选择新项目的存放位置"
          : "选择已有项目文件夹",
    defaultPath: "D:\\projects",
    properties: ["openDirectory"],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("alcor.codexFile", async (e) => {
  trusted(e);
  const r = await dialog.showOpenDialog(window!, {
    title: "选择 Codex CLI（codex.exe）",
    properties: ["openFile"],
    filters: [{ name: "Codex CLI", extensions: ["exe"] }],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("alcor.attach", async (e) => {
  trusted(e);
  const r = await dialog.showOpenDialog(window!, {
    title: "选择本轮附件（将保存本地副本，执行时发送）",
    properties: ["openFile", "multiSelections"],
  });
  if (r.canceled) return [];
  const out = [];
  for (const path of r.filePaths.slice(0, 12))
    out.push(await rpc({ internal: "attachment", path }));
  return out;
});
ipcMain.handle("alcor.credentials", async (e, kind: boolean | "dsh-desktop" = false) => {
  trusted(e);
  if (kind !== false && kind !== true && kind !== "dsh-desktop") throw new Error("凭据用途无效");
  const native = kind === true, dshDesktop = kind === "dsh-desktop";
  last = await rpc({ request: { op: "snapshot" } });
  const cfg = last!.settings;
  const endpoint = native
    ? `codex:${cfg.codexCredentialEnv}`
    : dshDesktop ? cfg.dshDesktopUrl : apiTarget(cfg).endpoint;
  if (!native && !endpoint) throw new Error(dshDesktop ? "请先保存 DSH 原桌面桥地址" : "请先保存 API 端点");
  if (native && !last!.settings.codexCredentialEnv)
    throw new Error("请先填写并保存原生提供商的凭据环境变量名");
  if (credentials) {
    credentials.focus();
    return;
  }
  credentialTarget = { native, dshDesktop, source: cfg.apiSource, endpoint };
  credentials = new BrowserWindow({
    parent: window,
    modal: true,
    width: 520,
    height: 380,
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  secureWindow(credentials);
  await credentials.loadFile(join(__dirname, "credential.html"), {
    query: {
      target: native
        ? "Codex 原生执行端"
        : (dshDesktop ? "DSH 原桌面桥" : cfg.apiSource === "deepseek" ? "DeepSeek 官方" : "自定义 API") +
          " · " +
          endpoint,
    },
  });
  credentials.on("closed", () => {
    credentials = undefined;
    credentialTarget = undefined;
    window?.webContents.send("alcor.changed");
  });
});
ipcMain.handle("credential.save", async (e, key) => {
  trusted(e, true);
  if (typeof key !== "string" || key.length > 4000)
    throw new Error("密钥格式无效");
  if (!credentialTarget) throw new Error("密钥窗口已失效");
  await rpc({
    internal: "credential",
    ...credentialTarget,
    key,
  });
  credentials?.close();
  return true;
});
ipcMain.on("credential.close", (e) => {
  if (e.sender === credentials?.webContents) credentials.close();
});
ipcMain.handle("alcor.restore", async (e) => {
  trusted(e);
  const r = await dialog.showOpenDialog(window!, {
    title: "选择包含 manifest.json 的星引备份目录",
    defaultPath: join(dataDir, "backups"),
    properties: ["openDirectory"],
  });
  if (r.canceled) return null;
  const a = await dialog.showMessageBox(window!, {
    type: "warning",
    message: "恢复这份备份？",
    detail:
      "先备份当前账本，再恢复所选记录。现有删除标记会保留，密钥不会从备份导入，工作区文件不会回滚。",
    buttons: ["取消", "恢复"],
    defaultId: 0,
    cancelId: 0,
  });
  if (a.response !== 1) return null;
  return rpc({ internal: "restore", path: r.filePaths[0] });
});
ipcMain.handle("alcor.dataDirectory", async (e) => {
  trusted(e);
  const s: Snapshot = await rpc({ request: { op: "snapshot" } });
  if (s.runs.some((r) => r.state !== "ended"))
    throw new Error("切换目录前请停止并核对所有执行");
  const r = await dialog.showOpenDialog(window!, {
    title: "选择下次启动使用的数据目录（不迁移旧数据）",
    defaultPath: "D:\\data\\alcor",
    properties: ["openDirectory", "createDirectory"],
  });
  if (r.canceled) return null;
  return {
    path: saveDesktopDataDirectory(bootstrap, r.filePaths[0]),
    restartRequired: true,
  };
});
ipcMain.handle("alcor.reveal", async (e, id) => {
  trusted(e);
  const a = await rpc({ request: { op: "artifact.read", id } });
  shell.showItemInFolder(a.path);
  return true;
});
ipcMain.handle("alcor.quit", async (e) => {
  trusted(e);
  await shutdown();
});
app.on("before-quit", (e) => {
  if (!quitting) {
    e.preventDefault();
    void shutdown();
  }
});
app.on("window-all-closed", () => {});
