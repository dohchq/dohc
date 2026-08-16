import { describe, expect, it } from "vitest";
import {
  allowGuestNavigation,
  clearPluginWebAppPartition,
  createPluginWebAppGuest,
  guestWebPreferences,
  hardenGuestSession,
  hardenGuestWebContents,
  parsePluginWebAppUrl,
  pluginWebAppPartition,
  type GuestNavigationEvent,
  type GuestSessionLike,
  type GuestViewLike,
  type GuestWebPreferences,
  type GuestWebContentsLike,
} from "./pluginWebAppGuest";

describe("pluginWebAppPartition", () => {
  it("derives a persist partition with only hashed identity in it", () => {
    const partition = pluginWebAppPartition("C:/ws/root", "t3-code");
    expect(partition).toMatch(/^persist:dohc-plugin-[0-9a-f]{32}$/);
    expect(partition).not.toContain("t3-code");
  });

  it("separates plugins sharing a workspace and workspaces sharing a plugin", () => {
    const base = pluginWebAppPartition("C:/ws/a", "t3-code");
    expect(pluginWebAppPartition("C:/ws/a", "other-plugin")).not.toBe(base);
    expect(pluginWebAppPartition("C:/ws/b", "t3-code")).not.toBe(base);
    expect(pluginWebAppPartition("C:/ws/a", "t3-code")).toBe(base);
  });

  it("keeps a hostile plugin id from shaping the partition string", () => {
    const partition = pluginWebAppPartition("C:/ws/a", "../../other");
    expect(partition).toMatch(/^persist:dohc-plugin-[0-9a-f]{32}$/);
    expect(partition).not.toContain("..");
  });
});

describe("parsePluginWebAppUrl", () => {
  it("accepts the exact loopback form and returns its origin", () => {
    const parsed = parsePluginWebAppUrl(
      "http://127.0.0.1:52835/pair#token=secret",
    );
    expect(parsed.origin).toBe("http://127.0.0.1:52835");
  });

  it.each([
    "https://127.0.0.1:52835/",
    "http://localhost:52835/",
    "http://[::1]:52835/",
    "http://192.168.1.5:52835/",
    "file:///C:/x.html",
    "not a url",
  ])("rejects %s", (url) => {
    expect(() => parsePluginWebAppUrl(url)).toThrow();
  });
});

describe("allowGuestNavigation", () => {
  const origin = "http://127.0.0.1:52835";

  it("allows same-origin paths, including the pair route", () => {
    expect(allowGuestNavigation(origin, `${origin}/`)).toBe(true);
    expect(allowGuestNavigation(origin, `${origin}/pair#token=x`)).toBe(true);
    expect(allowGuestNavigation(origin, `${origin}/threads/1`)).toBe(true);
  });

  it.each([
    "http://127.0.0.1:52836/",
    "http://localhost:52835/",
    "https://127.0.0.1:52835/",
    "https://example.com/",
    "file:///C:/x.html",
    "javascript:alert(1)",
    "not a url",
  ])("denies %s", (target) => {
    expect(allowGuestNavigation(origin, target)).toBe(false);
  });
});

describe("guestWebPreferences", () => {
  it("pins the hardened preferences with the partition and nothing else", () => {
    expect(guestWebPreferences("persist:dohc-plugin-abc")).toEqual({
      partition: "persist:dohc-plugin-abc",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    });
  });
});

interface RecordedNavigation {
  url: string;
  prevented: boolean;
}

function fakeWebContents(): {
  webContents: GuestWebContentsLike;
  navigate: (event: "will-navigate" | "will-redirect", url: string) => RecordedNavigation;
  openWindow: () => { action: string } | null;
} {
  const listeners = new Map<
    string,
    (event: GuestNavigationEvent, url: string) => void
  >();
  let windowOpenHandler: (() => { action: "deny" }) | null = null;
  const webContents: GuestWebContentsLike = {
    on(event: "will-navigate" | "will-redirect", listener: (event: GuestNavigationEvent, url: string) => void) {
      listeners.set(event, listener);
      return webContents;
    },
    setWindowOpenHandler(handler) {
      windowOpenHandler = handler;
    },
  };
  return {
    webContents,
    navigate(event, url) {
      const recorded: RecordedNavigation = { url, prevented: false };
      listeners.get(event)?.(
        { preventDefault: () => { recorded.prevented = true; } },
        url,
      );
      return recorded;
    },
    openWindow: () => windowOpenHandler?.() ?? null,
  };
}

describe("hardenGuestWebContents", () => {
  const origin = "http://127.0.0.1:52835";

  it("prevents main-frame navigation off the spawned origin", () => {
    const fake = fakeWebContents();
    hardenGuestWebContents(fake.webContents, origin);

    expect(fake.navigate("will-navigate", `${origin}/threads/9`).prevented).toBe(false);
    expect(fake.navigate("will-navigate", "https://example.com/").prevented).toBe(true);
  });

  it("prevents server redirects off the spawned origin", () => {
    const fake = fakeWebContents();
    hardenGuestWebContents(fake.webContents, origin);

    expect(fake.navigate("will-redirect", `${origin}/pair`).prevented).toBe(false);
    expect(fake.navigate("will-redirect", "http://127.0.0.1:1/").prevented).toBe(true);
  });

  it("denies every window open", () => {
    const fake = fakeWebContents();
    hardenGuestWebContents(fake.webContents, origin);
    expect(fake.openWindow()).toEqual({ action: "deny" });
  });
});

// The guest main.ts builds, built the way main.ts builds it. Everything the
// handler used to decide inline is decided in createPluginWebAppGuest, so the
// mutations that used to survive (a preload on the guest, an origin lock on
// an origin the guest never uses, session hardening that never runs, a
// credential-bearing "origin" handed back) are all visible from here.
interface FakeGuestView extends GuestViewLike {
  visibility: boolean[];
  navigate: (url: string) => boolean;
  permissionHandlerSet: number;
  settleLoad: (outcome: "ok" | "fail") => void;
  loadedUrls: string[];
}

function guestHarness() {
  const created: Array<{
    webPreferences: GuestWebPreferences;
    view: FakeGuestView;
  }> = [];
  const steps: string[] = [];

  class FakeView implements GuestViewLike {
    visibility: boolean[] = [];
    permissionHandlerSet = 0;
    loadedUrls: string[] = [];
    private navigationListeners: Array<
      (event: GuestNavigationEvent, url: string) => void
    > = [];
    private settle: ((outcome: "ok" | "fail") => void) | null = null;
    webContents: FakeGuestView["webContents"];

    constructor(options: { webPreferences: GuestWebPreferences }) {
      const view = this;
      const session: GuestSessionLike = {
        on(_event, _listener) {
          return session;
        },
        setPermissionRequestHandler() {
          view.permissionHandlerSet += 1;
          steps.push("harden-session");
        },
      };
      this.webContents = {
        session,
        on(_event: "will-navigate" | "will-redirect", listener) {
          view.navigationListeners.push(listener);
          steps.push("harden-contents");
          return this;
        },
        setWindowOpenHandler() {},
        loadURL(url: string) {
          view.loadedUrls.push(url);
          steps.push("load");
          return new Promise<void>((resolve, reject) => {
            view.settle = (outcome) =>
              outcome === "ok" ? resolve() : reject(new Error("load failed"));
          });
        },
      };
      created.push({ webPreferences: options.webPreferences, view: this });
    }

    setVisible(visible: boolean): void {
      this.visibility.push(visible);
      steps.push(`visible:${String(visible)}`);
    }

    navigate(url: string): boolean {
      let prevented = false;
      for (const listener of this.navigationListeners) {
        listener({ preventDefault: () => { prevented = true; } }, url);
      }
      return prevented;
    }

    settleLoad(outcome: "ok" | "fail"): void {
      this.settle?.(outcome);
    }
  }

  return { created, steps, FakeView };
}

const WORKSPACE_ROOT = "C:/ws/root";
const PLUGIN_ID = "t3-code";
const START_URL = "http://127.0.0.1:52835/pair#token=not-a-real-credential";

function createGuest(
  overrides: {
    hardenedPartitions?: Set<string>;
    url?: string;
    onLoadFailure?: (error: unknown) => void;
  } = {},
) {
  const harness = guestHarness();
  const attached: Array<{ origin: string; partition: string }> = [];
  const guest = createPluginWebAppGuest({
    workspaceRoot: WORKSPACE_ROOT,
    pluginId: PLUGIN_ID,
    url: overrides.url ?? START_URL,
    hardenedPartitions: overrides.hardenedPartitions ?? new Set<string>(),
    ViewClass: harness.FakeView,
    attach: (_view, record) => {
      harness.steps.push("attach");
      attached.push(record);
    },
    onLoadFailure: overrides.onLoadFailure ?? (() => undefined),
  });
  return { ...harness, attached, guest };
}

describe("createPluginWebAppGuest", () => {
  it("creates the view with the hardened preferences and no preload", () => {
    const { created, guest } = createGuest();
    expect(created).toHaveLength(1);
    // MUTATION (preload on the guest): a preload would grant the plugin's
    // page a scripting foothold in the renderer's world.
    expect(created[0]!.webPreferences).toEqual(
      guestWebPreferences(pluginWebAppPartition(WORKSPACE_ROOT, PLUGIN_ID)),
    );
    expect(created[0]!.webPreferences).not.toHaveProperty("preload");
    expect(guest.partition).toBe(
      pluginWebAppPartition(WORKSPACE_ROOT, PLUGIN_ID),
    );
  });

  it("locks navigation to the started URL's own origin", () => {
    const { created } = createGuest();
    const view = created[0]!.view;
    // MUTATION (harden against a fixed origin the guest never uses): the
    // guest's own pages would be blocked and any other page allowed.
    expect(view.navigate("http://127.0.0.1:52835/threads/1")).toBe(false);
    expect(view.navigate("http://127.0.0.1:1/")).toBe(true);
    expect(view.navigate("https://example.com/")).toBe(true);
  });

  it("hardens a partition's session exactly once, and every new partition", () => {
    const hardenedPartitions = new Set<string>();
    const first = createGuest({ hardenedPartitions });
    expect(first.created[0]!.view.permissionHandlerSet).toBe(1);

    // MUTATION (invert the hardened-partition branch): the first guest of a
    // partition is the one that must be hardened, and it never would be.
    const second = createGuest({ hardenedPartitions });
    expect(second.created[0]!.view.permissionHandlerSet).toBe(0);
    expect(hardenedPartitions.has(first.guest.partition)).toBe(true);
    expect(hardenedPartitions.size).toBe(1);
  });

  it("gives the credential to loadURL only, and reports the bare origin", () => {
    const { created, attached, guest } = createGuest();
    // MUTATION (origin: started.url minus its fragment): the renderer and the
    // registry would receive the credential-bearing URL's path instead.
    expect(guest.origin).toBe("http://127.0.0.1:52835");
    expect(attached).toEqual([
      {
        origin: "http://127.0.0.1:52835",
        partition: pluginWebAppPartition(WORKSPACE_ROOT, PLUGIN_ID),
      },
    ]);
    expect(created[0]!.view.loadedUrls).toEqual([START_URL]);
  });

  it("starts invisible and attaches before it navigates", () => {
    const { created, steps } = createGuest();
    expect(created[0]!.view.visibility).toEqual([false]);
    expect(steps).toEqual([
      "harden-session",
      "harden-contents",
      "harden-contents",
      "visible:false",
      "attach",
      "load",
    ]);
  });

  it("rejects a start URL that is not the loopback form", () => {
    expect(() => createGuest({ url: "https://example.com/pair" })).toThrow();
  });

  // A3: the credential is spent the moment the plugin hands the URL over. A
  // navigation that never lands leaves a paired server and no session cookie
  // to show for it, so the failure must reach the caller that can stop it.
  it("reports a navigation that never lands", async () => {
    const failures: unknown[] = [];
    const { created } = createGuest({
      onLoadFailure: (error) => failures.push(error),
    });
    created[0]!.view.settleLoad("fail");
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
  });

  it("stays quiet when the navigation lands", async () => {
    const failures: unknown[] = [];
    const { created } = createGuest({
      onLoadFailure: (error) => failures.push(error),
    });
    created[0]!.view.settleLoad("ok");
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
  });
});

describe("clearPluginWebAppPartition", () => {
  it("clears exactly the partition its own guest would have used", async () => {
    const cleared: string[] = [];
    const hardenedPartitions = new Set<string>([
      pluginWebAppPartition(WORKSPACE_ROOT, PLUGIN_ID),
    ]);

    await clearPluginWebAppPartition({
      workspaceRoot: WORKSPACE_ROOT,
      pluginId: PLUGIN_ID,
      hardenedPartitions,
      fromPartition: (partition) => {
        cleared.push(partition);
        return { clearStorageData: () => Promise.resolve() };
      },
      onError: (error) => {
        throw error;
      },
    });

    // MUTATION (clear a partition no guest ever used): uninstall would leave
    // the real partition's session cookies for the next installation.
    expect(cleared).toEqual([pluginWebAppPartition(WORKSPACE_ROOT, PLUGIN_ID)]);
    expect(hardenedPartitions.size).toBe(0);
  });

  it("reports a failed clear instead of throwing it", async () => {
    const reported: unknown[] = [];
    await clearPluginWebAppPartition({
      workspaceRoot: WORKSPACE_ROOT,
      pluginId: PLUGIN_ID,
      hardenedPartitions: new Set<string>(),
      fromPartition: () => ({
        clearStorageData: () => Promise.reject(new Error("locked")),
      }),
      onError: (error) => reported.push(error),
    });
    expect(reported).toHaveLength(1);
  });
});

describe("hardenGuestSession", () => {
  it("prevents downloads and denies permission requests", () => {
    let downloadListener: ((event: { preventDefault(): void }) => void) | null = null;
    let permissionHandler:
      | ((webContents: unknown, permission: string, callback: (granted: boolean) => void) => void)
      | null = null;
    const session: GuestSessionLike = {
      on(_event, listener) {
        downloadListener = listener;
        return session;
      },
      setPermissionRequestHandler(handler) {
        permissionHandler = handler;
      },
    };

    hardenGuestSession(session);

    let prevented = false;
    downloadListener!({ preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(true);

    const granted: boolean[] = [];
    permissionHandler!({}, "media", (result) => granted.push(result));
    permissionHandler!({}, "clipboard-read", (result) => granted.push(result));
    expect(granted).toEqual([false, false]);
  });
});
