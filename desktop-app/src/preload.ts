import { contextBridge, ipcRenderer } from "electron";

const credential = location.pathname.endsWith("credential.html");
if (credential) {
  contextBridge.exposeInMainWorld("credential", {
    save: (key: string) => ipcRenderer.invoke("credential.save", key),
    close: () => ipcRenderer.send("credential.close"),
  });
} else {
  contextBridge.exposeInMainWorld("alcor", {
    request: (request: unknown) => ipcRenderer.invoke("alcor.request", request),
    mobile: (input: unknown) => ipcRenderer.invoke("alcor.mobile", input),
    chooseDirectory: (purpose?: string) =>
      ipcRenderer.invoke("alcor.directory", purpose),
    openProject: (id: string) => ipcRenderer.invoke("alcor.openProject", id),
    everything: (action: string) =>
      ipcRenderer.invoke("alcor.everything", action),
    chooseCodex: () => ipcRenderer.invoke("alcor.codexFile"),
    attach: () => ipcRenderer.invoke("alcor.attach"),
    credentials: (kind: boolean | "dsh-desktop" = false) =>
      ipcRenderer.invoke("alcor.credentials", kind),
    restore: () => ipcRenderer.invoke("alcor.restore"),
    dataDirectory: () => ipcRenderer.invoke("alcor.dataDirectory"),
    reveal: (id: string) => ipcRenderer.invoke("alcor.reveal", id),
    quit: () => ipcRenderer.invoke("alcor.quit"),
    onChange: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on("alcor.changed", handler);
      return () => ipcRenderer.removeListener("alcor.changed", handler);
    },
    onError: (callback: (error: string) => void) => {
      const handler = (_: unknown, error: string) => callback(error);
      ipcRenderer.on("alcor.error", handler);
      return () => ipcRenderer.removeListener("alcor.error", handler);
    },
  });
}
