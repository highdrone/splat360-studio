/** Helpers around the optional Electron bridge. */

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && !!window.splat360;
}

export function bridge() {
  return typeof window !== 'undefined' ? window.splat360 : undefined;
}

export async function revealPath(path: string): Promise<boolean> {
  const b = bridge();
  if (b?.revealPath) {
    await b.revealPath(path);
    return true;
  }
  return false;
}

export async function openExternal(url: string): Promise<void> {
  const b = bridge();
  if (b?.openExternal) {
    await b.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
