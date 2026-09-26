import { create } from 'zustand';

export type Theme = 'dark' | 'light';
const THEME_KEY = 'splat360.theme';

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** ms; 0 = sticky until dismissed */
  timeout: number;
}

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface UiState {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;

  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;

  toasts: Toast[];
  toast: (kind: ToastKind, title: string, message?: string, timeout?: number) => number;
  dismissToast: (id: number) => void;

  confirm: PendingConfirm | null;
  askConfirm: (req: ConfirmRequest) => Promise<boolean>;
  resolveConfirm: (ok: boolean) => void;
}

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* ignore */
  }
  return 'dark';
}

function applyTheme(t: Theme) {
  try {
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* ignore */
  }
}

let toastSeq = 1;

export const useUiStore = create<UiState>((set, get) => ({
  theme: readTheme(),
  setTheme: (t) => {
    applyTheme(t);
    set({ theme: t });
  },
  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),

  toasts: [],
  toast: (kind, title, message, timeout) => {
    const id = toastSeq++;
    const t: Toast = { id, kind, title, message, timeout: timeout ?? (kind === 'error' ? 8000 : 4000) };
    set((s) => ({ toasts: [...s.toasts, t].slice(-5) }));
    if (t.timeout > 0) setTimeout(() => get().dismissToast(id), t.timeout);
    return id;
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  confirm: null,
  askConfirm: (req) =>
    new Promise<boolean>((resolve) => {
      const prev = get().confirm;
      if (prev) prev.resolve(false);
      set({ confirm: { ...req, resolve } });
    }),
  resolveConfirm: (ok) => {
    const c = get().confirm;
    if (c) c.resolve(ok);
    set({ confirm: null });
  },
}));

// Apply the persisted theme at module load (index.html also does this pre-paint).
if (typeof document !== 'undefined') applyTheme(readTheme());

export const toast = {
  success: (title: string, message?: string) => useUiStore.getState().toast('success', title, message),
  error: (title: string, message?: string) => useUiStore.getState().toast('error', title, message),
  info: (title: string, message?: string) => useUiStore.getState().toast('info', title, message),
  warning: (title: string, message?: string) => useUiStore.getState().toast('warning', title, message),
};

export const confirmDialog = (req: ConfirmRequest) => useUiStore.getState().askConfirm(req);
