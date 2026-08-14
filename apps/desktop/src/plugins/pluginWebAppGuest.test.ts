import { describe, expect, it } from "vitest";
import {
  allowGuestNavigation,
  guestWebPreferences,
  hardenGuestSession,
  hardenGuestWebContents,
  parsePluginWebAppUrl,
  pluginWebAppPartition,
  type GuestNavigationEvent,
  type GuestSessionLike,
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
