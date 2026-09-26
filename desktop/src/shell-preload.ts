/**
 * Preload for the small setup / error windows (setup.html, error.html).
 * Exposes `window.shell` with just what those pages need.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ShellState {
  phase: "checking" | "installing" | "starting" | "done" | "error";
  title?: string;
  message?: string;
  logTail?: string;
  logPath?: string;
  canRetry?: boolean;
}

const shell = {
  onLine(cb: (line: string) => void): () => void {
    const l = (_e: Electron.IpcRendererEvent, line: string) => cb(line);
    ipcRenderer.on("shell:line", l);
    return () => ipcRenderer.removeListener("shell:line", l);
  },
  onState(cb: (s: ShellState) => void): () => void {
    const l = (_e: Electron.IpcRendererEvent, s: ShellState) => cb(s);
    ipcRenderer.on("shell:state", l);
    ipcRenderer.send("shell:state-request");
    return () => ipcRenderer.removeListener("shell:state", l);
  },
  copyLog(): Promise<boolean> {
    return ipcRenderer.invoke("shell:copy-log") as Promise<boolean>;
  },
  showLog(): Promise<void> {
    return ipcRenderer.invoke("shell:show-log") as Promise<void>;
  },
  retry(): void {
    ipcRenderer.send("shell:retry");
  },
  quit(): void {
    ipcRenderer.send("shell:quit");
  },
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("splat360:open-external", String(url)) as Promise<void>;
  },
};

contextBridge.exposeInMainWorld("shell", shell);
