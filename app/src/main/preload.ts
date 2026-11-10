import { contextBridge, ipcRenderer } from "electron";
import type { Api, FileState } from "../shared/api";
import type { Op } from "../shared/model";

const api: Api = {
  getState: () => ipcRenderer.invoke("state:get"),
  apply: (op: Op) => ipcRenderer.invoke("data:apply", op),
  createFile: () => ipcRenderer.invoke("file:create"),
  openFile: () => ipcRenderer.invoke("file:open"),
  retry: () => ipcRenderer.invoke("file:retry"),
  revealFile: () => ipcRenderer.invoke("file:reveal"),
  onState: (cb) => { ipcRenderer.on("state", (_e, s: FileState) => cb(s)); },
  ready: () => ipcRenderer.send("ui:ready"),
};

contextBridge.exposeInMainWorld("api", api);
