/**
 * Pure helpers used by the Electron main process.
 *
 * Nothing in this file imports `electron`, so it can be unit-tested with
 * vitest on any platform.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

/** Data directory used by the engine (`--data-dir`). */
export function dataDirFor(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Splat360");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    return path.join(appData, "Splat360");
  }
  const xdg = process.env.XDG_DATA_HOME ?? path.join(home, ".local", "share");
  return path.join(xdg, "splat360");
}

/** Virtual environment that holds the installed engine. */
export function venvDirFor(dataDir: string): string {
  return path.join(dataDir, "venv");
}

/** Python interpreter inside a venv. */
export function venvPython(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** pip inside a venv. */
export function venvPip(venvDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? path.join(venvDir, "Scripts", "pip.exe")
    : path.join(venvDir, "bin", "pip");
}

// ---------------------------------------------------------------------------
// Python discovery
// ---------------------------------------------------------------------------

export interface PythonCandidateOptions {
  env: NodeJS.ProcessEnv;
  home: string;
  /** Electron `process.resourcesPath` (packaged builds). */
  resourcesPath: string;
  /** Directory of the engine checkout when running from source. */
  engineDir: string;
  platform?: NodeJS.Platform;
}

/** Extra directories searched for `python3` besides PATH, in priority order. */
export const EXTRA_PYTHON_DIRS_DARWIN = [
  "/opt/homebrew/bin",
  "/opt/homebrew/opt/python@3.13/bin",
  "/opt/homebrew/opt/python@3.12/bin",
  "/opt/homebrew/opt/python@3.11/bin",
  "/usr/local/bin",
  "/usr/local/opt/python@3.12/bin",
  "/Library/Frameworks/Python.framework/Versions/3.12/bin",
  "/Library/Frameworks/Python.framework/Versions/3.11/bin",
  "/usr/bin",
];

/**
 * Ordered list of interpreter paths to try. The list is *not* filtered by
 * existence; call {@link firstExisting} for that. Order:
 *
 * 1. `SPLAT360_PYTHON` env
 * 2. `<data-dir>/venv/bin/python`
 * 3. bundled `resources/engine/.venv/bin/python`
 * 4. `python3` on PATH plus well-known Homebrew / system locations
 */
export function pythonCandidates(opts: PythonCandidateOptions): string[] {
  const platform = opts.platform ?? process.platform;
  const out: string[] = [];
  const envPy = opts.env.SPLAT360_PYTHON?.trim();
  if (envPy) out.push(envPy);
  out.push(venvPython(venvDirFor(dataDirFor(opts.home, platform)), platform));
  out.push(venvPython(path.join(opts.resourcesPath, "engine", ".venv"), platform));
  out.push(venvPython(path.join(opts.engineDir, ".venv"), platform));
  for (const p of systemPythonCandidates(opts.env, platform)) {
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `python3` executables on PATH plus the well-known extra directories. */
export function systemPythonCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exe = platform === "win32" ? "python.exe" : "python3";
  const sep = platform === "win32" ? ";" : ":";
  const dirs = (env.PATH ?? "").split(sep).filter(Boolean);
  if (platform === "darwin") dirs.push(...EXTRA_PYTHON_DIRS_DARWIN);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of dirs) {
    const p = path.join(d, exe);
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/** First path in `candidates` that exists and is executable, or null. */
export function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }
  return null;
}

export function isExecutable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== "win32") fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parse the output of `python -c "import sys; print(sys.version)"`. */
export function parsePythonVersion(text: string): { major: number; minor: number } | null {
  const m = /(\d+)\.(\d+)/.exec(text);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export const MIN_PYTHON = { major: 3, minor: 11 };

export function pythonVersionOk(v: { major: number; minor: number } | null): boolean {
  if (!v) return false;
  return v.major > MIN_PYTHON.major || (v.major === MIN_PYTHON.major && v.minor >= MIN_PYTHON.minor);
}

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

/** Ask the OS for a free TCP port on `host`. */
export function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
  });
}

/** `http://127.0.0.1:N` -> `ws://127.0.0.1:N`. */
export function wsOrigin(apiBase: string): string {
  return apiBase.replace(/^http(s?):\/\//, "ws$1://");
}

/**
 * Content-Security-Policy for the renderer. In dev mode the Vite dev server
 * (HMR websocket, inline scripts) must be allowed too.
 */
export function buildCsp(apiBase: string, opts: { dev?: boolean; devServer?: string } = {}): string {
  const ws = wsOrigin(apiBase);
  const dev = opts.dev ?? false;
  const devServer = opts.devServer ?? "http://localhost:5173";
  const devWs = wsOrigin(devServer);
  const self = ["'self'"];
  const scriptSrc = [...self, "'wasm-unsafe-eval'", ...(dev ? ["'unsafe-inline'", "'unsafe-eval'", devServer] : [])];
  const connect = [...self, apiBase, ws, "blob:", "data:", ...(dev ? [devServer, devWs] : [])];
  const directives: Record<string, string[]> = {
    "default-src": self,
    "script-src": scriptSrc,
    "style-src": [...self, "'unsafe-inline'", ...(dev ? [devServer] : [])],
    "img-src": [...self, apiBase, "blob:", "data:", ...(dev ? [devServer] : [])],
    "media-src": [...self, apiBase, "blob:", "data:"],
    "font-src": [...self, "data:", ...(dev ? [devServer] : [])],
    "connect-src": connect,
    "worker-src": [...self, "blob:"],
    "child-src": [...self, "blob:"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": self,
    "form-action": self,
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

// ---------------------------------------------------------------------------
// Input validation for IPC handlers
// ---------------------------------------------------------------------------

/** Only absolute paths that exist may be revealed in Finder. */
export function isRevealablePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (p.includes("\0")) return false;
  if (!path.isAbsolute(p)) return false;
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Only http(s) URLs are opened in the default browser. */
export function isHttpUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length === 0 || u.length > 8192) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Strip path separators and control characters from a suggested file name. */
export function safeFileName(name: unknown, fallback = "download.pdf"): string {
  if (typeof name !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:\x00-\x1f]/g, "_").replace(/^\.+/, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : fallback;
}

/** Last `n` lines of a text blob. */
export function tailLines(text: string, n: number): string {
  if (n <= 0) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Read the last `n` lines of a file, tolerating a missing file. */
export function tailFile(file: string, n: number, maxBytes = 256 * 1024): string {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, "r");
    try {
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return tailLines(buf.toString("utf8"), n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export function homeDir(): string {
  return process.env.HOME ?? os.homedir();
}
