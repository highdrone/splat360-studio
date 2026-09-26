/**
 * First-run bootstrap: create the engine virtualenv and install the engine
 * package into it. Runs the equivalent of
 *
 *   python3 -m venv <venv> && <venv>/bin/pip install -e <engine dir>
 *
 * Output lines are delivered through the `onLine` callback so the setup
 * window can show them live. No `electron` import here.
 */
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";

import {
  firstExisting,
  isExecutable,
  parsePythonVersion,
  pythonVersionOk,
  systemPythonCandidates,
  venvPip,
  venvPython,
  MIN_PYTHON,
} from "./helpers";

export interface BootstrapOptions {
  venvDir: string;
  engineDir: string;
  /** Editable install (dev checkout) or a regular install (packaged app). */
  editable: boolean;
  onLine: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

export class BootstrapError extends Error {
  constructor(
    message: string,
    readonly kind: "no-python" | "python-too-old" | "venv" | "pip",
  ) {
    super(message);
  }
}

export const HOMEBREW_PYTHON_HINT =
  `Splat360 Studio needs Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor} or newer.\n` +
  "Install it with Homebrew:\n\n" +
  '  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n' +
  "  brew install python@3.12\n\n" +
  "or run scripts/setup-mac.sh from the repository, then relaunch the app.";

/** Does the venv already contain a usable interpreter with splat360 installed? */
export function venvIsUsable(venvDir: string): boolean {
  const py = venvPython(venvDir);
  if (!isExecutable(py)) return false;
  const r = spawnSync(py, ["-c", "import splat360, fastapi, uvicorn"], { encoding: "utf8", timeout: 20_000 });
  return r.status === 0;
}

/** Version of an interpreter, or null when it cannot be executed. */
export function pythonVersionOf(python: string): { major: number; minor: number } | null {
  const r = spawnSync(python, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (r.status !== 0) return null;
  return parsePythonVersion(r.stdout);
}

/**
 * Find a system Python that satisfies MIN_PYTHON. Throws BootstrapError
 * with kind `no-python` or `python-too-old`.
 */
export function findSystemPython(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = systemPythonCandidates(env).filter(isExecutable);
  if (candidates.length === 0) {
    throw new BootstrapError("python3 was not found on this machine.\n\n" + HOMEBREW_PYTHON_HINT, "no-python");
  }
  let newest: { path: string; v: { major: number; minor: number } } | null = null;
  for (const c of candidates) {
    const v = pythonVersionOf(c);
    if (!v) continue;
    if (pythonVersionOk(v)) return c;
    if (!newest || v.major > newest.v.major || (v.major === newest.v.major && v.minor > newest.v.minor)) {
      newest = { path: c, v };
    }
  }
  const found = newest ? `${newest.path} is Python ${newest.v.major}.${newest.v.minor}` : "no working python3";
  throw new BootstrapError(`Found ${found}, which is too old.\n\n` + HOMEBREW_PYTHON_HINT, "python-too-old");
}

function run(cmd: string, args: string[], onLine: (l: string) => void, env?: NodeJS.ProcessEnv): Promise<number> {
  onLine(`$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const feed = (s: NodeJS.ReadableStream | null) => {
      if (!s) return;
      let buf = "";
      s.on("data", (c: Buffer) => {
        buf += c.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          onLine(buf.slice(0, i).replace(/\r$/, ""));
          buf = buf.slice(i + 1);
        }
      });
      s.on("end", () => buf && onLine(buf));
    };
    feed(child.stdout);
    feed(child.stderr);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

/**
 * Create the venv and install the engine. Resolves with the venv python path.
 * Idempotent: an existing usable venv is reused and only `pip install` runs.
 */
export async function bootstrapVenv(opts: BootstrapOptions): Promise<string> {
  const { venvDir, engineDir, onLine } = opts;
  const py = venvPython(venvDir);
  const pip = venvPip(venvDir);

  if (!fs.existsSync(engineDir) || !fs.existsSync(`${engineDir}/pyproject.toml`)) {
    throw new BootstrapError(`Engine sources not found at ${engineDir}`, "pip");
  }

  if (!isExecutable(py)) {
    const sys = findSystemPython(opts.env);
    onLine(`Using ${sys} to create the virtual environment at ${venvDir}`);
    fs.mkdirSync(venvDir, { recursive: true });
    const code = await run(sys, ["-m", "venv", "--upgrade-deps", venvDir], onLine, opts.env);
    if (code !== 0 || !isExecutable(py)) {
      // `--upgrade-deps` needs network; retry without it before giving up.
      const code2 = await run(sys, ["-m", "venv", venvDir], onLine, opts.env);
      if (code2 !== 0 || !isExecutable(py)) {
        throw new BootstrapError(`python -m venv failed (exit ${code2})`, "venv");
      }
    }
  } else {
    onLine(`Reusing existing virtual environment at ${venvDir}`);
  }

  const pipArgs = ["install", "--upgrade"];
  if (opts.editable) pipArgs.push("-e");
  pipArgs.push(engineDir);
  const pipExe = isExecutable(pip) ? pip : py;
  const finalArgs = pipExe === pip ? pipArgs : ["-m", "pip", ...pipArgs];
  const code = await run(pipExe, finalArgs, onLine, opts.env);
  if (code !== 0) {
    throw new BootstrapError(`pip install failed (exit ${code}). See the output above.`, "pip");
  }
  if (!venvIsUsable(venvDir)) {
    throw new BootstrapError("The engine was installed but cannot be imported.", "pip");
  }
  onLine("Engine installed.");
  return py;
}
