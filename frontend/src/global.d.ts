/**
 * Desktop bridge exposed by the Electron preload script (see docs/API.md).
 * In the browser `window.splat360` is undefined.
 */
export interface EngineStatus {
  state: 'starting' | 'ready' | 'error';
  message?: string;
}

export interface Splat360Bridge {
  apiBase: string;
  platform: 'darwin' | 'win32' | 'linux';
  version: string;
  pickVideo(): Promise<string | null>;
  pickDirectory(): Promise<string | null>;
  revealPath(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  savePdf(bytes: ArrayBuffer, suggestedName: string): Promise<string | null>;
  onEngineStatus(cb: (s: EngineStatus) => void): () => void;
}

declare global {
  interface Window {
    splat360?: Splat360Bridge;
  }
}

export {};
