import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => "/tmp/dohc-test-user-data" },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getAllDisplays: () => [] },
}));

vi.mock("../workspaces/WorkspaceRegistry", () => ({
  stateDir: () => "/state",
}));

import {
  persistedChromeTheme,
  rememberChromeTheme,
  resetChromeThemeForTests,
  trackWindowState,
  type WindowRole,
} from "./createMainWindow";
import {
  MANAGER_WINDOW_SIZE,
  MANAGER_WINDOW_STATE_FILE,
  WINDOW_STATE_FILE,
  parseWindowState,
} from "./windowState";

class Window extends EventEmitter {
  destroyed = false;
  constructor(public bounds: { x: number; y: number; width: number; height: number }) {
    super();
  }
  isDestroyed() { return this.destroyed; }
  getNormalBounds() { return this.bounds; }
  isMaximized() { return false; }
  close() { this.emit("close"); this.destroyed = true; this.emit("closed"); }
}

const FILE: Record<WindowRole, string> = {
  workspace: WINDOW_STATE_FILE,
  manager: MANAGER_WINDOW_STATE_FILE,
};

function disk() {
  const files = new Map<string, string>();
  // Paths come through node:path, so match on the file name, not the separator.
  const contents = (role: WindowRole) =>
    [...files.entries()].find(([file]) => file.endsWith(FILE[role]))?.[1];
  return {
    files,
    io: {
      read: (file: string) => files.get(file) ?? null,
      write: (file: string, contents: string) => { files.set(file, contents); },
    },
    bounds: (role: WindowRole) =>
      parseWindowState(contents(role), role === "manager" ? MANAGER_WINDOW_SIZE : undefined)?.bounds,
  };
}

// A restart: module state resets, the files on disk stay.
function relaunch(d: ReturnType<typeof disk>) {
  resetChromeThemeForTests(d.io);
}

let d: ReturnType<typeof disk>;
beforeEach(() => { d = disk(); resetChromeThemeForTests(d.io); });
afterEach(() => { resetChromeThemeForTests(); });

describe("chrome theme across windows", () => {
  it.each([
    ["workspace", "manager"],
    ["manager", "workspace"],
  ] as const)("keeps the theme current in a closed %s file when the %s flips it", (closedRole, openRole) => {
    const closed = new Window({ x: 0, y: 0, width: 1280, height: 800 });
    const open = new Window({ x: 40, y: 40, width: 900, height: 700 });
    trackWindowState(closed, closedRole);
    trackWindowState(open, openRole);
    // Both roles have geometry on disk from earlier use; a close persists
    // without destroying in this fake.
    open.emit("close");
    rememberChromeTheme("dark");
    closed.close();
    expect(persistedChromeTheme(closedRole)).toBe("dark");

    rememberChromeTheme("light");
    // The closed role's file follows the flip and keeps its own geometry.
    expect(persistedChromeTheme(closedRole)).toBe("light");
    expect(persistedChromeTheme(openRole)).toBe("light");
    expect(d.bounds(closedRole)).toEqual(closed.bounds);
    expect(d.bounds(openRole)).toEqual(open.bounds);

    // Next launch opens the closed role first and reads the current theme.
    relaunch(d);
    expect(persistedChromeTheme(closedRole)).toBe("light");
    expect(persistedChromeTheme(openRole)).toBe("light");
  });

  it("does not let a theme flip overwrite geometry a newer window of the same role saved", () => {
    const older = new Window({ x: 0, y: 0, width: 1280, height: 800 });
    const newer = new Window({ x: 200, y: 100, width: 1400, height: 900 });
    trackWindowState(older, "workspace");
    trackWindowState(newer, "workspace");
    newer.emit("close");
    expect(d.bounds("workspace")).toEqual(newer.bounds);
    rememberChromeTheme("dark");
    expect(d.bounds("workspace")).toEqual(newer.bounds);
    expect(persistedChromeTheme("workspace")).toBe("dark");
  });

  it("writes the running theme on close even when no flip happened after tracking", () => {
    rememberChromeTheme("dark");
    const manager = new Window({ x: 40, y: 40, width: 880, height: 600 });
    trackWindowState(manager, "manager");
    manager.close();
    expect(persistedChromeTheme("manager")).toBe("dark");
  });

  it("leaves a never-opened role without a file until its first window writes one", () => {
    rememberChromeTheme("dark");
    expect(d.files.size).toBe(0);
  });
});
