/**
 * Engine process manager.
 *
 * Spawns `python -m splat360 serve` on a free localhost port, waits for
 * `/api/health`, restarts it a bounded number of times if it crashes, and
 * tears the whole process tree down on quit.
 *
 * This module does not import `electron`; the main process wires its events
 * to windows and IPC.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { findFreePort, tailFile } from "./helpers";

export interface EngineStatus {
  state: "starting" | "ready" | "error";
  message?: string;
}

export interface EngineOptions {
  /** Absolute path to the Python interpreter (normally the venv's). */
  python: string;
  /** Directory that contains the `splat360` package (cwd for the process). */
  engineDir: string;
  /** Passed as `--data-dir`. */
  dataDir: string;
  /** Directory that receives `engine.log`. */
  logDir: string;
  /** Milliseconds to wait for `/api/health` (default 60 s). */
  healthTimeoutMs?: number;
  /** Automatic restarts after a crash (default 3). */
  maxRestarts?: number;
  /** Grace period between SIGTERM and SIGKILL (default 5 s). */
  killGraceMs?: number;
  /** Extra environment for the child. */
  env?: NodeJS.ProcessEnv;
  /** Optional console logger (defaults to `console`). */
  log?: (line: string) => void;
}

export interface EngineEvents {
  status: (s: EngineStatus) => void;
  log: (line: string) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class EngineManager extends EventEmitter {
  readonly logPath: string;
  private readonly opts: Required<Omit<EngineOptions, "env" | "log">> & Pick<EngineOptions, "env" | "log">;
  private child: ChildProcess | null = null;
  private port = 0;
  private restarts = 0;
  private stopping = false;
  private logStream: fs.WriteStream | null = null;
  private _status: EngineStatus = { state: "starting" };

  constructor(options: EngineOptions) {
    super();
    this.opts = {
      healthTimeoutMs: 60_000,
      maxRestarts: 3,
      killGraceMs: 5_000,
      ...options,
    };
    fs.mkdirSync(this.opts.logDir, { recursive: true });
    this.logPath = path.join(this.opts.logDir, "engine.log");
  }

  get status(): EngineStatus {
    return this._status;
  }

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Last `n` lines of engine.log. */
  logTail(n = 200): string {
    return tailFile(this.logPath, n);
  }

  /** Start the engine and resolve once `/api/health` answers. */
  async start(): Promise<void> {
    this.stopping = false;
    this.restarts = 0;
    if (!this.port) this.port = await findFreePort();
    this.openLog();
    this.spawnChild();
    await this.waitForHealth();
  }

  /** Stop the engine: SIGTERM the process group, SIGKILL after the grace period. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.closeLog();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.killTree(child, "SIGKILL");
      }, this.opts.killGraceMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      this.killTree(child, "SIGTERM");
      // Safety net: never hang quit for more than grace + 2 s.
      setTimeout(resolve, this.opts.killGraceMs + 2_000).unref();
    });
    this.closeLog();
  }

  // -------------------------------------------------------------------------

  private setStatus(s: EngineStatus): void {
    this._status = s;
    this.emit("status", s);
  }

  private openLog(): void {
    if (this.logStream) return;
    this.logStream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.writeLog(`==== engine session ${new Date().toISOString()} ====`);
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = null;
  }

  private writeLog(line: string): void {
    const text = line.endsWith("\n") ? line : `${line}\n`;
    this.logStream?.write(text);
    (this.opts.log ?? ((l: string) => console.log(l)))(`[engine] ${line.trimEnd()}`);
    this.emit("log", line.trimEnd());
  }

  private spawnChild(): void {
    const { python, engineDir, dataDir } = this.opts;
    const args = ["-m", "splat360", "serve", "--host", "127.0.0.1", "--port", String(this.port), "--data-dir", dataDir];
    this.writeLog(`spawn: ${python} ${args.join(" ")} (cwd ${engineDir})`);
    this.setStatus({ state: "starting", message: "Starting engine…" });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.opts.env,
      PYTHONUNBUFFERED: "1",
      SPLAT360_DATA_DIR: dataDir,
      // Homebrew binaries (ffmpeg, colmap) and cargo (brush) must be reachable
      // even when the app was launched from Finder with a minimal PATH.
      PATH: withToolPaths(process.env.PATH ?? "", dataDir),
    };

    const child = spawn(python, args, {
      cwd: engineDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so we can kill the whole tree (COLMAP, ffmpeg, brush).
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.child = child;

    const pipe = (stream: NodeJS.ReadableStream | null) => {
      if (!stream) return;
      let buf = "";
      stream.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          this.writeLog(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
        }
      });
      stream.on("end", () => {
        if (buf) this.writeLog(buf);
      });
    };
    pipe(child.stdout);
    pipe(child.stderr);

    child.on("error", (err) => {
      this.writeLog(`spawn error: ${err.message}`);
      this.setStatus({ state: "error", message: `Could not start Python: ${err.message}` });
    });

    child.on("exit", (code, signal) => {
      this.writeLog(`exited code=${code} signal=${signal}`);
      this.emit("exit", code, signal);
      if (this.child === child) this.child = null;
      if (this.stopping) return;
      if (this.restarts < this.opts.maxRestarts) {
        this.restarts += 1;
        const delay = 500 * this.restarts;
        this.writeLog(`restarting (${this.restarts}/${this.opts.maxRestarts}) in ${delay} ms`);
        setTimeout(() => {
          if (this.stopping) return;
          this.spawnChild();
          this.waitForHealth().catch((e: Error) => {
            this.setStatus({ state: "error", message: e.message });
          });
        }, delay);
      } else {
        this.setStatus({
          state: "error",
          message: `Engine crashed ${this.restarts + 1} times (last exit code ${code ?? signal}). See engine.log.`,
        });
      }
    });
  }

  private killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        // Negative pid = the process group created by `detached: true`.
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  private waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.opts.healthTimeoutMs;
    const child = this.child;
    return new Promise<void>((resolve, reject) => {
      const attempt = () => {
        if (this.stopping) return reject(new Error("engine stopped"));
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
          return reject(new Error(`engine exited before becoming ready (code ${child.exitCode ?? child.signalCode})`));
        }
        if (Date.now() > deadline) {
          return reject(new Error(`engine did not answer /api/health within ${this.opts.healthTimeoutMs / 1000}s`));
        }
        healthCheck(this.apiBase, 1500)
          .then((ok) => {
            if (ok) {
              this.writeLog(`ready at ${this.apiBase}`);
              this.setStatus({ state: "ready", message: this.apiBase });
              resolve();
            } else {
              setTimeout(attempt, 500);
            }
          })
          .catch(() => setTimeout(attempt, 500));
      };
      attempt();
    });
  }
}

/** GET /api/health; true when the body says `ok`. */
export function healthCheck(apiBase: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${apiBase}/api/health`, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(false);
        try {
          const j = JSON.parse(body) as { ok?: boolean };
          resolve(j.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/** Prepend the directories where Homebrew, cargo and Splat360 keep binaries. */
export function withToolPaths(currentPath: string, dataDir: string): string {
  const home = process.env.HOME ?? "";
  const extra = [
    path.join(dataDir, "bin"),
    path.join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = currentPath.split(sep).filter(Boolean);
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  return parts.join(sep);
}
