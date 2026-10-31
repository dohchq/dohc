import { describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({}));
import { AppViewId, AppViewRequest } from "../ipc/bridgeContract";
import { appViewExternalUrl, appViewLaunchUrl, appViewNavigationAllowed, appViewPartition, appViewGuestPreferences, appViewShortcut } from "./appViews";

describe("app view boundaries", () => {
  it("accepts HTTP, HTTPS, and mailto links, and never exports loopback links", () => {
    for (const url of ["https://example.com/path", "http://example.com/path", "mailto:a@example.com", "https://127.example.com/"]) expect(appViewExternalUrl(url)).toBe(url);
    for (const url of ["file:///tmp/app", "javascript:alert(1)", "data:text/html,x", "dohc:open", "//example.com", "bad",
      "http://127.0.0.1:43210/other", "http://localhost/", "http://localhost./", "http://127.1/", "http://[::1]/",
      "http://0.0.0.0:8080/", "http://127.0.0.2/", "http://app.localhost/", "http://[::ffff:127.0.0.1]/", "http://[::]/"])
      expect(appViewExternalUrl(url)).toBeNull();
  });
  it("loads only the launcher's loopback bootstrap handoff", () => {
    const valid = `http://127.0.0.1:43210/bootstrap#${"a".repeat(43)}`;
    expect(appViewLaunchUrl(valid)).toBe(valid);
    for (const url of [valid.replace("127.0.0.1", "localhost"), valid.replace("http:", "https:"),
      valid.replace("/bootstrap", "/other"), valid.replace("/bootstrap", "/bootstrap?redirect=https://example.com"),
      valid.replace("127.0.0.1", "user@127.0.0.1"), "http://127.0.0.1:43210/bootstrap", "file:///bootstrap"])
      expect(appViewLaunchUrl(url)).toBeNull();
  });
  it("keeps bootstrap in its main frame and opaque documents in child frames", () => {
    const origin = "http://127.0.0.1:43210";
    for (const url of [`${origin}/bootstrap`, `${origin}/bootstrap#handoff`]) expect(appViewNavigationAllowed(url, true, origin)).toBe(true);
    for (const url of ["about:srcdoc", "about:blank"]) {
      expect(appViewNavigationAllowed(url, false, origin)).toBe(true);
      expect(appViewNavigationAllowed(url, true, origin)).toBe(false);
    }
    for (const url of [`${origin}/backend`, `${origin}/bootstrap?x=1`, "http://127.0.0.1:43211/bootstrap", "https://example.com", "data:text/html,x"])
      for (const main of [true, false]) expect(appViewNavigationAllowed(url, main, origin)).toBe(false);
    expect(appViewNavigationAllowed(`${origin}/bootstrap`, false, origin)).toBe(false);
  });
  it("validates view IDs and rejects renderer-supplied launch addresses", () => {
    for (const value of ["a", "A_z-012", "a".repeat(64)]) expect(AppViewId.safeParse(value).success).toBe(true);
    for (const value of ["", "a".repeat(65), "../app", "app id", "é", "a\n"]) expect(AppViewId.safeParse(value).success).toBe(false);
    expect(AppViewRequest.safeParse({ action: "open", workspaceId: "w", viewId: "app", appRoot: "app", colorScheme: "light", url: "https://example.com" }).success).toBe(false);
    expect(AppViewRequest.safeParse({ action: "colorScheme", workspaceId: "w", colorScheme: "dark" }).success).toBe(true);
    expect(AppViewRequest.safeParse({ action: "capture", workspaceId: "w", viewId: "app" }).success).toBe(false);
  });
  it("uses a stable, in-memory partition per app without exposing the workspace name", () => {
    const partition = appViewPartition("private-workspace", "one");
    expect(partition).toMatch(/^dohc-app:[a-f0-9]{32}$/);
    expect(partition).toBe(appViewPartition("private-workspace", "one"));
    expect(partition).not.toBe(appViewPartition("private-workspace", "two"));
    expect(partition).not.toBe(appViewPartition("other-workspace", "one"));
    expect(partition).not.toContain("private-workspace");
    expect(partition).not.toContain("persist:");
  });
  it("provides only main-owned guest preferences, without a preload", () => {
    const prefs = appViewGuestPreferences("dohc-app:test", true);
    expect(prefs).toMatchObject({ partition: "dohc-app:test", sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, devTools: false,
      spellcheck: false, webSecurity: true, allowRunningInsecureContent: false });
    expect(prefs).not.toHaveProperty("preload");
    expect(prefs).not.toHaveProperty("preloadURL");
    expect(prefs).toMatchObject({ transparent: true, disablePopups: false });
    expect(appViewGuestPreferences("p", false).devTools).toBe(true);
  });
  it("forwards only workbench shortcuts and browser navigation keys", () => {
    const input = { type: "keyDown", key: "p", code: "KeyP", control: true, shift: false, alt: false, meta: false, isComposing: false };
    for (const key of ["p", "k", "w", "b", "r"]) expect(appViewShortcut({ ...input, key }, "win32")).not.toBeNull();
    expect(appViewShortcut({ ...input, shift: true }, "win32")).not.toBeNull();
    for (const key of ["F5", "F6"]) expect(appViewShortcut({ ...input, key, control: false }, "win32")).not.toBeNull();
    for (const shift of [true, false]) expect(appViewShortcut({ ...input, key: "Tab", shift }, "darwin")).not.toBeNull();
    for (const key of ["PageDown", "PageUp"]) expect(appViewShortcut({ ...input, key, code: key }, "win32")).not.toBeNull();
    for (const [key, code] of [["}", "BracketRight"], ["{", "BracketLeft"]])
      expect(appViewShortcut({ ...input, key, code, control: false, meta: true, shift: true }, "darwin")).not.toBeNull();
    for (const key of ["ArrowLeft", "ArrowRight"]) expect(appViewShortcut({ ...input, key, control: false, alt: true }, "win32")).not.toBeNull();
    expect(appViewShortcut({ ...input, key: "BrowserBack", control: false }, "win32")).toMatchObject({ key: "ArrowLeft", altKey: true });
    expect(appViewShortcut({ ...input, control: false, meta: true }, "darwin")).not.toBeNull();
    for (const key of ["c", "v", "x", "a", "z", "n", "Enter", "Escape", "ArrowLeft", "ArrowDown"])
      expect(appViewShortcut({ ...input, key }, "win32")).toBeNull();
    expect(appViewShortcut({ ...input, key: "PageDown", code: "PageDown", control: false }, "win32")).toBeNull();
    expect(appViewShortcut({ ...input, type: "keyUp" }, "win32")).toBeNull();
    expect(appViewShortcut({ ...input, isComposing: true }, "win32")).toBeNull();
    expect(appViewShortcut({ ...input, alt: true }, "win32")).toBeNull();
  });
});
