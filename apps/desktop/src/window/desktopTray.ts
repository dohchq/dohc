import { configuredRunnerCommand } from "../agents/agentToolCatalog";
import { join } from "node:path";
import type { MenuItemConstructorOptions } from "electron";
import type { DesktopUserSettingsResult } from "../settings/userSettings";
import type { ChatDispatchService } from "../agents/chatDispatchService";
import {
  applyDesktopIconToPlatform,
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
    readonly dock?: { setIcon(path: string): void };
  };
  process: Pick<NodeJS.Process, "platform"> & { resourcesPath?: string };
  moduleDirectory: string;
  Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): Menu };
  nativeImage: { createFromPath(path: string): Image };
  nativeTheme: { readonly shouldUseDarkColors: boolean };
  Tray: new (image: Image) => DesktopTrayInstance<Image, Menu>;
  BrowserWindow: { getAllWindows(): Array<{ setIcon(path: string): void }> };
  readCachedUserSettingsFile(directory: string): Promise<DesktopUserSettingsResult>;
  stateDir(): string;
  chatDispatchService: Pick<ChatDispatchService, "isPaused" | "setPaused">;
  showOrCreateMainWindow(): Promise<unknown>;
  /** How many schedules this computer runs. Any keep dohc in the tray. */
  runningSchedules(): number;
  readonly appLifecycle: { isQuitting(): boolean };
}) {
  const {
    app, process, Menu, nativeImage, nativeTheme, Tray, BrowserWindow,
    readCachedUserSettingsFile, stateDir, chatDispatchService, showOrCreateMainWindow,
  } = dependencies;

  let dispatchTray: DesktopTrayInstance<Image, Menu> | null = null;
  let dispatchEnabled = false;

  function configuredRunnerEnabled(settings: DesktopUserSettingsResult["settings"]): boolean {
    return settings.runner.enabled && configuredRunnerCommand(settings.runner).length > 0;
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
    if (process.platform === "darwin") icon.setTemplateImage(true);
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

  function refreshSystemThemeDesktopIcons(): void {
    const iconPath = currentDesktopIconPath();
    if (iconPath) {
      applyDesktopIconToPlatform({
        platform: process.platform,
        iconPath,
        windows: BrowserWindow.getAllWindows(),
        setDockIcon: (path) => app.dock?.setIcon(path),
      });
    }
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


  /** Whether agent dispatch keeps dohc running, as the last refresh read it. */
  const dispatchKeepsRunning = () => dispatchEnabled;

  return { refreshDispatchTray, refreshSystemThemeDesktopIcons, dispatchKeepsRunning };
}
