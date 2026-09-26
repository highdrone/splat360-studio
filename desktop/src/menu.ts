/**
 * Application menu (macOS layout; works on other platforms too).
 */
import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron";

export const ISSUES_URL = "https://github.com/splat360/splat360-studio/issues";
export const DOCS_URL = "https://github.com/splat360/splat360-studio#readme";

export interface MenuActions {
  getWindow: () => BrowserWindow | null;
  navigate: (route: string) => void;
  showEngineLog: () => void;
  openDataFolder: () => void;
  openLogFolder: () => void;
  restartEngine: () => void;
}

export function buildMenu(actions: MenuActions): Menu {
  const isMac = process.platform === "darwin";

  const appMenu: MenuItemConstructorOptions = {
    label: app.name,
    submenu: [
      { role: "about" },
      { type: "separator" },
      {
        label: "Environment Check…",
        accelerator: "CmdOrCtrl+Shift+E",
        click: () => actions.navigate("/doctor"),
      },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "New Project…",
        accelerator: "CmdOrCtrl+N",
        click: () => actions.navigate("/projects/new"),
      },
      {
        label: "All Projects",
        accelerator: "CmdOrCtrl+Shift+O",
        click: () => actions.navigate("/"),
      },
      { type: "separator" },
      {
        label: "Print AprilTags…",
        accelerator: "CmdOrCtrl+P",
        click: () => actions.navigate("/tags"),
      },
      {
        label: "Capture Guide",
        accelerator: "CmdOrCtrl+Shift+G",
        click: () => actions.navigate("/guide"),
      },
      { type: "separator" },
      {
        label: "Open Data Folder",
        click: () => actions.openDataFolder(),
      },
      {
        label: "Show Engine Log",
        accelerator: "CmdOrCtrl+Shift+L",
        click: () => actions.showEngineLog(),
      },
      {
        label: "Restart Engine",
        click: () => actions.restartEngine(),
      },
      ...(isMac ? [] : [{ type: "separator" } as MenuItemConstructorOptions, { role: "quit" } as MenuItemConstructorOptions]),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      ...(isMac
        ? [
            { role: "pasteAndMatchStyle" } as MenuItemConstructorOptions,
            { role: "delete" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ]
        : [
            { role: "delete" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "selectAll" } as MenuItemConstructorOptions,
          ]),
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "forceReload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(isMac
        ? [
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "front" } as MenuItemConstructorOptions,
            { type: "separator" } as MenuItemConstructorOptions,
            { role: "window" } as MenuItemConstructorOptions,
          ]
        : [{ role: "close" } as MenuItemConstructorOptions]),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: [
      {
        label: "Documentation",
        click: () => void shell.openExternal(DOCS_URL),
      },
      {
        label: "Capture Guide",
        click: () => actions.navigate("/guide"),
      },
      { type: "separator" },
      {
        label: "GitHub Issues",
        click: () => void shell.openExternal(ISSUES_URL),
      },
      {
        label: "Report a Bug… (opens log folder)",
        click: () => {
          actions.openLogFolder();
          void shell.openExternal(`${ISSUES_URL}/new`);
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];
  return Menu.buildFromTemplate(template);
}

/** Dock menu (macOS). */
export function buildDockMenu(actions: Pick<MenuActions, "navigate">): Menu {
  return Menu.buildFromTemplate([
    { label: "New Project", click: () => actions.navigate("/projects/new") },
    { label: "Print AprilTags", click: () => actions.navigate("/tags") },
    { label: "Environment Check", click: () => actions.navigate("/doctor") },
  ]);
}
