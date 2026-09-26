/**
 * Preload for the main (frontend) window. Exposes `window.splat360` exactly as
 * documented in docs/API.md "Desktop bridge". Runs sandboxed with context
 * isolation; nothing here touches Node APIs beyond `ipcRenderer`.
 */
import { contextBridge, ipcRenderer } from "electron";

interface EngineStatus {
  state: "starting" | "ready" | "error";
  message?: string;
}

interface Boot {
  apiBase: string;
  platform: "darwin" | "win32" | "linux";
  version: string;
}

// One synchronous call at startup so `apiBase` is a plain string property.
const boot = ipcRenderer.sendSync("splat360:boot") as Boot;

const bridge = {
  apiBase: boot.apiBase,
  platform: boot.platform,
  version: boot.version,

  pickVideo(): Promise<string | null> {
    return ipcRenderer.invoke("splat360:pick-video") as Promise<string | null>;
  },

  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("splat360:pick-directory") as Promise<string | null>;
  },

  revealPath(path: string): Promise<void> {
    return ipcRenderer.invoke("splat360:reveal-path", String(path)) as Promise<void>;
  },

  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke("splat360:open-external", String(url)) as Promise<void>;
  },

  savePdf(bytes: ArrayBuffer, suggestedName: string): Promise<string | null> {
    // Uint8Array survives structured cloning across the IPC boundary.
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return ipcRenderer.invoke("splat360:save-pdf", view, String(suggestedName)) as Promise<string | null>;
  },

  onEngineStatus(cb: (s: EngineStatus) => void): () => void {
    const listener = (_e: Electron.IpcRendererEvent, s: EngineStatus) => cb(s);
    ipcRenderer.on("engine-status", listener);
    // Ask main to replay the current status so late subscribers are not stuck on "starting".
    ipcRenderer.send("splat360:engine-status-request");
    return () => {
      ipcRenderer.removeListener("engine-status", listener);
    };
  },
};

contextBridge.exposeInMainWorld("splat360", bridge);

// Menu-driven navigation. The bridge interface in docs/API.md has no slot for
// this, so it is delivered as a DOM event the UI can listen for:
//   window.addEventListener("splat360:navigate", (e) => navigate(e.detail))
// `detail` is a plain string (objects do not cross the isolated-world boundary).
ipcRenderer.on("navigate", (_e, route: string) => {
  window.dispatchEvent(new CustomEvent("splat360:navigate", { detail: String(route) }));
});
