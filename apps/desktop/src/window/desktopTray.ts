import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import { firstAgent, type DesktopUserSettingsResult } from "../settings/userSettings";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import {
  resolveDesktopIconDirectory,
  resolveSystemThemeIconPath,
} from "../systemThemeIcon";

interface DesktopTrayImage {
  isEmpty(): boolean;
  setTemplateImage(template: boolean): void;
}

interface DesktopTrayInstance<Image, Menu> {
  setContextMenu(menu: Menu): void;
  setToolTip(text: string): void;
  on(event: "double-click", listener: () => void): unknown;
  setImage(image: Image): void;
  destroy(): void;
}

export function createDesktopTray<Image extends DesktopTrayImage, Menu>(dependencies: {
  app: {
    readonly isPackaged: boolean;
    getAppPath(): string;
    quit(): void;
  };
  process: Pick<NodeJS.Process, "platform"> & { resourcesPath?: string };
  moduleDirectory: string;
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu };
  nativeImage: { createFromPath(path: string): Image };
  nativeTheme: { readonly shouldUseDarkColors: boolean };
  Tray: new (image: Image) => DesktopTrayInstance<Image, Menu>;
  readCachedUserSettingsFile(directory: string): Promise<DesktopUserSettingsResult>;
  stateDir(): string;
  chatDispatchService: Pick<ChatDispatchService, "isPaused" | "setPaused">;
  showOrCreateMainWindow(): Promise<unknown>;
  /** How many schedules this computer runs. Any keep dohc in the tray. */
  runningSchedules(): number;
  readonly appLifecycle: { isQuitting(): boolean };
  Notification: new (options: { title: string; body: string }) => {
    on(event: "click", listener: () => void): unknown;
    show(): void;
  };
  /** Whether the Linux desktop shows tray icons. */
  linuxTrayShown(): Promise<boolean>;
  hasWindow(): boolean;
}) {
  const {
    app, process, Menu, nativeImage, nativeTheme, Tray,
    readCachedUserSettingsFile, stateDir, chatDispatchService, showOrCreateMainWindow,
  } = dependencies;

  let dispatchTray: DesktopTrayInstance<Image, Menu> | null = null;
  let dispatchEnabled = false;

  function configuredRunnerEnabled(settings: DesktopUserSettingsResult["settings"]): boolean {
    return firstAgent(settings)?.enabled === true;
  }

  function desktopIconDirectory(): string {
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    return resolveDesktopIconDirectory({
      isPackaged: app.isPackaged,
      resourcesPath,
      moduleDirectory: dependencies.moduleDirectory,
    });
  }

  function currentDesktopIconPath(): string | null {
    return resolveSystemThemeIconPath(
      desktopIconDirectory(),
      nativeTheme.shouldUseDarkColors,
    );
  }

  function dispatchTrayIcon() {
    // The macOS menu bar draws a monochrome template image and tints it for
    // its own appearance; the app icon would draw as a dark blob there.
    if (process.platform === "darwin") {
      const template = nativeImage.createFromPath(join(desktopIconDirectory(), "trayTemplate.png"));
      template.setTemplateImage(true);
      return template;
    }
    const resourcesPath = (
      process as NodeJS.Process & { resourcesPath?: string }
    ).resourcesPath;
    const themedPath = currentDesktopIconPath();
    const packagedFallback = resourcesPath
      ? join(resourcesPath, "tray-icon.png")
      : "";
    let icon = nativeImage.createFromPath(themedPath ?? packagedFallback);
    if (icon.isEmpty()) {
      icon = nativeImage.createFromPath(join(app.getAppPath(), "build/icon.png"));
    }
    return icon;
  }

  function rebuildDispatchTrayMenu(): void {
    if (!dispatchTray) return;
    const schedules = dependencies.runningSchedules();
    dispatchTray.setToolTip(dispatchEnabled ? "dohc agent dispatch" : "dohc");
    dispatchTray.setContextMenu(
      Menu.buildFromTemplate([
        {
          label: "Open dohc",
          click: () => {
            void showOrCreateMainWindow();
          },
        },
        ...(schedules > 0
          ? [{ label: schedules === 1 ? "Running 1 schedule" : `Running ${schedules} schedules`, enabled: false }]
          : []),
        ...(dispatchEnabled
          ? [{
            label: "Pause agent dispatch",
            type: "checkbox" as const,
            checked: chatDispatchService.isPaused(),
            click: (item: { checked: boolean }) => {
              chatDispatchService.setPaused(item.checked);
              rebuildDispatchTrayMenu();
            },
          }]
          : []),
        { type: "separator" },
        {
          label: "Quit dohc",
          click: () => app.quit(),
        },
      ]),
    );
  }

  function ensureDispatchTray(): void {
    if (!dispatchTray) {
      dispatchTray = new Tray(dispatchTrayIcon());
      dispatchTray.on("double-click", () => {
        void showOrCreateMainWindow();
      });
    }
    rebuildDispatchTrayMenu();
  }

  function refreshTrayIcon(): void {
    if (dispatchTray) dispatchTray.setImage(dispatchTrayIcon());
  }

  // The tray keeps dohc running after its windows close while agent
  // dispatch is on or this computer runs a schedule.
  async function refreshDispatchTray(): Promise<boolean> {
    const { settings } = await readCachedUserSettingsFile(stateDir());
    dispatchEnabled = configuredRunnerEnabled(settings);
    const enabled = dispatchEnabled || dependencies.runningSchedules() > 0;
    if (enabled && !dependencies.appLifecycle.isQuitting()) {
      ensureDispatchTray();
    } else if (dispatchTray) {
      dispatchTray.destroy();
      dispatchTray = null;
    }
    return enabled;
  }


  // Without a tray, as on stock GNOME, nothing shows that dohc keeps running
  // after its last window closes. Say so once a run, and how to quit. The
  // notice is kept: Electron drops its click listener once it is collected.
  let backgroundNotice: InstanceType<typeof dependencies.Notification> | null = null;
  async function noticeRunningInBackground(): Promise<void> {
    if (process.platform !== "linux" || backgroundNotice) return;
    const trayShown = await dependencies.linuxTrayShown();
    // A quit, a reopened window, or another close's notice may have come
    // during the check, which can take seconds on a slow session bus.
    if (trayShown || backgroundNotice || dependencies.hasWindow() || dependencies.appLifecycle.isQuitting()) return;
    const schedules = dependencies.runningSchedules();
    const notice = new dependencies.Notification({
      title: "dohc is still running",
      body: [
        ...(dispatchEnabled ? [chatDispatchService.isPaused() ? "Agent dispatch is paused." : "Agent dispatch is on."] : []),
        ...(schedules > 0 ? [schedules === 1 ? "Running 1 schedule." : `Running ${schedules} schedules.`] : []),
        "To quit, open dohc and press Ctrl+Q.",
      ].join(" "),
    });
    backgroundNotice = notice;
    notice.on("click", () => {
      void showOrCreateMainWindow();
    });
    notice.show();
  }

  /** Whether agent dispatch keeps dohc running, as the last refresh read it. */
  const dispatchKeepsRunning = () => dispatchEnabled;

  return { refreshDispatchTray, refreshTrayIcon, dispatchKeepsRunning, noticeRunningInBackground };
}
