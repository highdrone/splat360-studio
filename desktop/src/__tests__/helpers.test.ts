import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildCsp,
  dataDirFor,
  findFreePort,
  firstExisting,
  isHttpUrl,
  isRevealablePath,
  parsePythonVersion,
  pythonCandidates,
  pythonVersionOk,
  safeFileName,
  systemPythonCandidates,
  tailLines,
  wsOrigin,
} from "../helpers";
import { withToolPaths } from "../engine";

describe("python candidate ordering", () => {
  const base = {
    home: "/Users/alice",
    resourcesPath: "/Applications/Splat360 Studio.app/Contents/Resources",
    engineDir: "/repo/engine",
    platform: "darwin" as const,
  };

  it("puts SPLAT360_PYTHON first, then the user venv, then bundled venv, then PATH", () => {
    const c = pythonCandidates({ ...base, env: { SPLAT360_PYTHON: "/custom/python", PATH: "/usr/local/bin:/usr/bin" } });
    expect(c[0]).toBe("/custom/python");
    expect(c[1]).toBe("/Users/alice/Library/Application Support/Splat360/venv/bin/python");
    expect(c[2]).toBe("/Applications/Splat360 Studio.app/Contents/Resources/engine/.venv/bin/python");
    expect(c[3]).toBe("/repo/engine/.venv/bin/python");
    expect(c.slice(4)).toContain("/usr/local/bin/python3");
    expect(c.slice(4)).toContain("/opt/homebrew/bin/python3");
  });

  it("omits the env entry when SPLAT360_PYTHON is unset or blank", () => {
    const c = pythonCandidates({ ...base, env: { SPLAT360_PYTHON: "  ", PATH: "" } });
    expect(c[0]).toBe("/Users/alice/Library/Application Support/Splat360/venv/bin/python");
  });

  it("PATH entries come before the Homebrew fallbacks and are de-duplicated", () => {
    const c = systemPythonCandidates({ PATH: "/opt/homebrew/bin:/my/bin:/opt/homebrew/bin" }, "darwin");
    expect(c[0]).toBe("/opt/homebrew/bin/python3");
    expect(c[1]).toBe("/my/bin/python3");
    expect(c.filter((p) => p === "/opt/homebrew/bin/python3")).toHaveLength(1);
    expect(c).toContain("/usr/bin/python3");
  });

  it("firstExisting returns null when nothing exists", () => {
    expect(firstExisting(["/definitely/not/here/python3"])).toBeNull();
  });

  it("dataDirFor follows the macOS convention", () => {
    expect(dataDirFor("/Users/bob", "darwin")).toBe("/Users/bob/Library/Application Support/Splat360");
  });
});

describe("python version parsing", () => {
  it("parses and compares", () => {
    expect(parsePythonVersion("3.12")).toEqual({ major: 3, minor: 12 });
    expect(parsePythonVersion("Python 3.9.6")).toEqual({ major: 3, minor: 9 });
    expect(parsePythonVersion("garbage")).toBeNull();
    expect(pythonVersionOk({ major: 3, minor: 11 })).toBe(true);
    expect(pythonVersionOk({ major: 3, minor: 12 })).toBe(true);
    expect(pythonVersionOk({ major: 3, minor: 10 })).toBe(false);
    expect(pythonVersionOk(null)).toBe(false);
  });
});

describe("port picking", () => {
  it("returns a port that can be bound", async () => {
    const port = await findFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.on("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("wsOrigin maps http to ws", () => {
    expect(wsOrigin("http://127.0.0.1:53211")).toBe("ws://127.0.0.1:53211");
    expect(wsOrigin("https://example.com")).toBe("wss://example.com");
  });
});

describe("path and url validation", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "splat360-test-"));
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("only reveals absolute paths that exist", () => {
    expect(isRevealablePath(path.join(tmp, "a.txt"))).toBe(true);
    expect(isRevealablePath(tmp)).toBe(true);
    expect(isRevealablePath(path.join(tmp, "missing"))).toBe(false);
    expect(isRevealablePath("relative/path")).toBe(false);
    expect(isRevealablePath("")).toBe(false);
    expect(isRevealablePath(42)).toBe(false);
    expect(isRevealablePath("/tmp/\0evil")).toBe(false);
  });

  it("only opens http(s) urls", () => {
    expect(isHttpUrl("https://github.com/x")).toBe(true);
    expect(isHttpUrl("http://localhost:5173")).toBe(true);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
    expect(isHttpUrl(null)).toBe(false);
  });

  it("sanitises suggested file names", () => {
    expect(safeFileName("tags.pdf")).toBe("tags.pdf");
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("")).toBe("download.pdf");
    expect(safeFileName(undefined, "x.pdf")).toBe("x.pdf");
  });
});

describe("csp", () => {
  it("allows the engine origin over http and ws plus blob/data", () => {
    const csp = buildCsp("http://127.0.0.1:53211");
    const connect = csp.split("; ").find((d) => d.startsWith("connect-src "))!;
    expect(connect).toContain("http://127.0.0.1:53211");
    expect(connect).toContain("ws://127.0.0.1:53211");
    expect(connect).toContain("blob:");
    expect(connect).toContain("data:");
    expect(csp).not.toContain("localhost:5173");
    expect(csp).toContain("frame-src 'none'");
  });

  it("adds the vite dev server in dev mode", () => {
    const csp = buildCsp("http://127.0.0.1:1", { dev: true });
    expect(csp).toContain("ws://localhost:5173");
    expect(csp).toContain("'unsafe-inline'");
  });
});

describe("misc", () => {
  it("tailLines keeps the last n lines", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc");
    expect(tailLines("a\r\nb", 5)).toBe("a\nb");
    expect(tailLines("x", 0)).toBe("");
  });

  it("withToolPaths appends homebrew/cargo/data bin dirs once", () => {
    const p = withToolPaths("/usr/bin:/opt/homebrew/bin", "/data");
    const parts = p.split(":");
    expect(parts.filter((x) => x === "/opt/homebrew/bin")).toHaveLength(1);
    expect(parts).toContain("/data/bin");
    expect(parts.some((x) => x.endsWith("/.cargo/bin"))).toBe(true);
  });
});
