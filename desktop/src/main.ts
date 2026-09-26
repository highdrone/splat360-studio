/**
 * Electron main process for Splat360 Studio.
 *
 * Startup sequence:
 *   1. single-instance lock, menu, dock menu
 *   2. locate a Python interpreter; if the engine venv is missing, show the
 *      setup window and bootstrap it (python3 -m venv + pip install)
 *   3. spawn the engine on a free port and wait for /api/health
 *   4. open the main window on frontend/dist (or the Vite dev server)
 *
 * Quitting the last window quits the app (no hide-on-close); quitting tears
 * down the engine process tree.
 */
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { bootstrapVenv, BootstrapError, venvIsUsable } from "./bootstrap";
import { EngineManager, type EngineStatus } from "./engine";
import {
  buildCsp,
  dataDirFor,
  firstExisting,
  isHttpUrl,
  isRevealablePath,
  pythonCandidates,
  safeFileName,
  venvDirFor,
  venvPython,
} from "./helpers";
import { buildDockMenu, buildMenu } from "./menu";
import type { ShellState } from "./shell-preload";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const IS_DEV = process.env.SPLAT360_DEV === "1";
const DEV_SERVER = process.env.SPLAT360_DEV_SERVER ?? "http://localhost:5173";
const HOME = os.homedir();

/** desktop/ when running from source; the asar root when packaged. */
const APP_ROOT = app.getAppPath();
const REPO_ROOT = path.resolve(APP_ROOT, "..");

const ENGINE_DIR = app.isPackaged ? path.join(process.resourcesPath, "engine") : path.join(REPO_ROOT, "engine");
const FRONTEND_INDEX = app.isPackaged
  ? path.join(process.resourcesPath, "frontend", "dist", "index.html")
  : path.join(REPO_ROOT, "frontend", "dist", "index.html");
const DATA_DIR = process.env.SPLAT360_DATA_DIR ?? dataDirFor(HOME);
const VENV_DIR = venvDirFor(DATA_DIR);
const LOG_DIR = app.getPath("logs");
const HTML_DIR = path.join(APP_ROOT, "src");

app.setName("Splat360 Studio");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let shellWindow: BrowserWindow | null = null;
let engine: EngineManager | null = null;
let shellState: ShellState = { phase: "checking", message: "Checking the Python environment…" };
let quitting = false;
let cspInstalled = false;

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const w = mainWindow ?? shellWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });
  void app.whenReady().then(boot);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  installIpc();
  installMenus();
  app.on("activate", () => {
    // macOS: clicking the dock icon with no windows open re-creates the window.
    if (BrowserWindow.getAllWindows().length === 0 && engine?.status.state === "ready") {
      void createMainWindow();
    }
  });
  await startEverything();
}

async function startEverything(): Promise<void> {
  try {
    const python = await ensurePython();
    await startEngine(python);
    closeShellWindow();
    await createMainWindow();
  } catch (err) {
    const e = err as Error;
    console.error("[main] startup failed:", e);
    showErrorWindow(e instanceof BootstrapError ? "Setup failed" : "The engine could not be started", e.message);
  }
}

/** Find a usable interpreter, bootstrapping the venv on first run. */
async function ensurePython(): Promise<string> {
  const candidates = pythonCandidates({
    env: process.env,
    home: HOME,
    resourcesPath: process.resourcesPath,
    engineDir: ENGINE_DIR,
  });

  // Explicit override or an existing venv wins.
  const explicit = process.env.SPLAT360_PYTHON?.trim();
  if (explicit) return explicit;
  if (venvIsUsable(VENV_DIR)) return venvPython(VENV_DIR);
  const bundled = firstExisting(candidates.filter((c) => c.includes(`${path.sep}.venv${path.sep}`)));
  if (bundled) return bundled;

  // First run: create the venv with live output in the setup window.
  await showShellWindow("setup.html", { width: 640, height: 460 });
  setShellState({ phase: "installing", title: "Setting up the Splat360 engine", message: `Installing into ${VENV_DIR}` });
  const python = await bootstrapVenv({
    venvDir: VENV_DIR,
    engineDir: ENGINE_DIR,
    editable: !app.isPackaged,
    onLine: (line) => shellWindow?.webContents.send("shell:line", line),
  });
  setShellState({ phase: "starting", message: "Engine installed. Starting…" });
  return python;
}

async function startEngine(python: string): Promise<void> {
  if (engine) {
    await engine.stop();
    engine.removeAllListeners();
  }
  engine = new EngineManager({
    python,
    engineDir: ENGINE_DIR,
    dataDir: DATA_DIR,
    logDir: LOG_DIR,
    log: (l) => console.log(l),
  });
  engine.on("status", (s: EngineStatus) => {
    mainWindow?.webContents.send("engine-status", s);
    if (s.state === "error" && !quitting) {
      showErrorWindow("The engine stopped", s.message ?? "Unknown error");
    }
  });
  await engine.start();
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

async function createMainWindow(): Promise<void> {
  if (!engine) throw new Error("engine not started");
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  installCsp(engine.apiBase);

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "Splat360 Studio",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: "#111214",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // External links go to the default browser; the window never navigates away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      if (isHttpUrl(url)) void shell.openExternal(url);
    }
  });

  if (IS_DEV) {
    await mainWindow.loadURL(DEV_SERVER);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    if (!fs.existsSync(FRONTEND_INDEX)) {
      throw new Error(
        `Frontend build not found at ${FRONTEND_INDEX}. Run "npm --prefix frontend run build" (or use SPLAT360_DEV=1 with the Vite dev server).`,
      );
    }
    await mainWindow.loadFile(FRONTEND_INDEX);
  }
  mainWindow.webContents.send("engine-status", engine.status);
}

function isAllowedNavigation(url: string): boolean {
  if (IS_DEV && url.startsWith(DEV_SERVER)) return true;
  if (url.startsWith("file://")) return true;
  if (engine && url.startsWith(engine.apiBase)) return true;
  return false;
}

function installCsp(apiBase: string): void {
  if (cspInstalled) return;
  cspInstalled = true;
  const csp = buildCsp(apiBase, { dev: IS_DEV, devServer: DEV_SERVER });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    // Only the app document gets the policy; engine API responses are left alone.
    const isDoc = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
    if (!isDoc || details.url.startsWith(apiBase)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [csp],
      },
    });
  });
}

async function showShellWindow(file: "setup.html" | "error.html", size: { width: number; height: number }): Promise<void> {
  if (shellWindow && !shellWindow.isDestroyed()) {
    await shellWindow.loadFile(path.join(HTML_DIR, file));
    shellWindow.setSize(size.width, size.height);
    shellWindow.show();
    return;
  }
  shellWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    resizable: true,
    minimizable: false,
    fullscreenable: false,
    title: "Splat360 Studio",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#17181b",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "shell-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  shellWindow.on("closed", () => {
    shellWindow = null;
  });
  await shellWindow.loadFile(path.join(HTML_DIR, file));
  shellWindow.show();
}

function closeShellWindow(): void {
  if (shellWindow && !shellWindow.isDestroyed()) shellWindow.close();
  shellWindow = null;
}

function setShellState(patch: Partial<ShellState>): void {
  shellState = { ...shellState, ...patch };
  shellWindow?.webContents.send("shell:state", shellState);
}

function showErrorWindow(title: string, message: string): void {
  const logPath = engine?.logPath ?? path.join(LOG_DIR, "engine.log");
  void showShellWindow("error.html", { width: 720, height: 520 }).then(() => {
    setShellState({
      phase: "error",
      title,
      message,
      logPath,
      logTail: engine?.logTail(200) ?? "",
      canRetry: true,
    });
  });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

function navigate(route: string): void {
  if (mainWindow) {
    mainWindow.webContents.send("navigate", route);
    mainWindow.focus();
  } else if (engine?.status.state === "ready") {
    void createMainWindow().then(() => mainWindow?.webContents.send("navigate", route));
  }
}

function installMenus(): void {
  const actions = {
    getWindow: () => mainWindow,
    navigate,
    showEngineLog: () => {
      const p = engine?.logPath ?? path.join(LOG_DIR, "engine.log");
      if (fs.existsSync(p)) shell.showItemInFolder(p);
      else void shell.openPath(LOG_DIR);
    },
    openDataFolder: () => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      void shell.openPath(DATA_DIR);
    },
    openLogFolder: () => {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      void shell.openPath(LOG_DIR);
    },
    restartEngine: () => {
      void (async () => {
        if (!engine) return;
        const python = firstExisting([
          process.env.SPLAT360_PYTHON ?? "",
          venvPython(VENV_DIR),
        ].filter(Boolean));
        if (!python) return;
        mainWindow?.webContents.send("engine-status", { state: "starting", message: "Restarting engine…" });
        try {
          await startEngine(python);
          mainWindow?.webContents.send("engine-status", engine.status);
        } catch (e) {
          showErrorWindow("The engine could not be restarted", (e as Error).message);
        }
      })();
    },
  };
  Menu.setApplicationMenu(buildMenu(actions));
  if (process.platform === "darwin") app.dock?.setMenu(buildDockMenu(actions));
}

// ---------------------------------------------------------------------------
// IPC (window.splat360 bridge + shell windows)
// ---------------------------------------------------------------------------

function senderIsMain(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return mainWindow !== null && e.sender.id === mainWindow.webContents.id;
}

function installIpc(): void {
  ipcMain.on("splat360:boot", (e) => {
    e.returnValue = {
      apiBase: engine?.apiBase ?? "",
      platform: process.platform,
      version: app.getVersion(),
    };
  });

  ipcMain.on("splat360:engine-status-request", (e) => {
    if (engine) e.sender.send("engine-status", engine.status);
  });

  ipcMain.handle("splat360:pick-video", async (e) => {
    if (!senderIsMain(e) || !mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a 360° video",
      properties: ["openFile"],
      filters: [
        { name: "Video", extensions: ["mp4", "mov", "m4v", "insv", "mkv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle("splat360:pick-directory", async (e) => {
    if (!senderIsMain(e) || !mainWindow) return null;
    const r = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a folder",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });

  ipcMain.handle("splat360:reveal-path", async (e, p: unknown) => {
    if (!senderIsMain(e)) return;
    if (!isRevealablePath(p)) throw new Error("Path does not exist");
    shell.showItemInFolder(p);
  });

  ipcMain.handle("splat360:open-external", async (e, url: unknown) => {
    // Allowed from the main window and the shell windows.
    const okSender = senderIsMain(e) || (shellWindow !== null && e.sender.id === shellWindow.webContents.id);
    if (!okSender) return;
    if (!isHttpUrl(url)) throw new Error("Only http(s) URLs can be opened");
    await shell.openExternal(url);
  });

  ipcMain.handle("splat360:save-pdf", async (e, bytes: unknown, suggestedName: unknown) => {
    if (!senderIsMain(e) || !mainWindow) return null;
    const buf = toBuffer(bytes);
    if (!buf || buf.length === 0) throw new Error("No data to save");
    if (buf.length > 512 * 1024 * 1024) throw new Error("File too large");
    const name = safeFileName(suggestedName, "apriltags.pdf");
    const r = await dialog.showSaveDialog(mainWindow, {
      title: "Save PDF",
      defaultPath: path.join(app.getPath("downloads"), name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.promises.writeFile(r.filePath, buf);
    return r.filePath;
  });

  // Shell windows -----------------------------------------------------------
  ipcMain.on("shell:state-request", (e) => e.sender.send("shell:state", shellState));
  ipcMain.handle("shell:copy-log", async () => {
    const text = engine?.logTail(2000) ?? shellState.logTail ?? "";
    clipboard.writeText(text);
    return text.length > 0;
  });
  ipcMain.handle("shell:show-log", async () => {
    const p = engine?.logPath ?? path.join(LOG_DIR, "engine.log");
    if (fs.existsSync(p)) shell.showItemInFolder(p);
    else void shell.openPath(LOG_DIR);
  });
  ipcMain.on("shell:retry", () => {
    setShellState({ phase: "checking", message: "Retrying…", logTail: "" });
    void startEverything();
  });
  ipcMain.on("shell:quit", () => app.quit());
}

function toBuffer(bytes: unknown): Buffer | null {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

app.on("window-all-closed", () => {
  // Explicit product decision: closing the window quits, also on macOS.
  app.quit();
});

let engineStopped = false;
app.on("before-quit", (event) => {
  quitting = true;
  if (engineStopped || !engine) return;
  event.preventDefault();
  const e = engine;
  void e.stop().finally(() => {
    engineStopped = true;
    app.quit();
  });
});

process.on("uncaughtException", (err) => {
  console.error("[main] uncaught exception:", err);
});
