import { describe, expect, it } from "vitest";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  isSafeExternalUrl,
  validateDevServerUrl,
} from "./electronSecurity";

describe("main window web preferences", () => {
  it("locks down the renderer: no node, isolated context, sandboxed", () => {
    const prefs = createMainWindowWebPreferences("/abs/path/preload.js");
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.sandbox).toBe(true);
  });

  it("requires an absolute preload path", () => {
    expect(() => createMainWindowWebPreferences("relative/preload.js")).toThrow(
      /absolute/i,
    );
  });
});

describe("navigation policy", () => {
  const policy = {
    httpOrigins: ["http://localhost:5173"],
    fileUrlPrefix: "file:///app/dist/renderer/",
  };

  it("allows in-app navigation", () => {
    expect(
      decideNavigation("file:///app/dist/renderer/index.html", policy),
    ).toEqual({ action: "allow" });
    expect(
      decideNavigation("http://localhost:5173/route", policy),
    ).toEqual({ action: "allow" });
  });

  it("denies navigation to arbitrary external URLs", () => {
    expect(decideNavigation("https://evil.example.com", policy).action).toBe(
      "deny",
    );
  });

  it("denies origin prefix-spoofing (localhost:5173.evil.com)", () => {
    expect(
      decideNavigation("http://localhost:5173.evil.com/x", policy).action,
    ).toBe("deny");
  });

  it("denies local files outside the renderer bundle", () => {
    expect(decideNavigation("file:///etc/passwd", policy).action).toBe("deny");
  });

  it("denies file navigation entirely when no bundle prefix is set (dev)", () => {
    expect(
      decideNavigation("file:///app/dist/renderer/index.html", {
        httpOrigins: ["http://localhost:5173"],
        fileUrlPrefix: null,
      }).action,
    ).toBe("deny");
  });

  it("denies unparseable URLs", () => {
    expect(decideNavigation("not a url", policy).action).toBe("deny");
  });

  it("denies about:blank and javascript: URLs", () => {
    expect(decideNavigation("about:blank", policy).action).toBe("deny");
    expect(decideNavigation("javascript:alert(1)", policy).action).toBe(
      "deny",
    );
  });
});

describe("dev server URL validation", () => {
  it("accepts loopback dev servers in unpackaged builds", () => {
    expect(validateDevServerUrl("http://localhost:5173", false)).toBe(
      "http://localhost:5173",
    );
    expect(validateDevServerUrl("http://127.0.0.1:5173", false)).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("rejects everything in packaged builds", () => {
    expect(validateDevServerUrl("http://localhost:5173", true)).toBeNull();
  });

  it("rejects non-loopback and non-http origins in dev", () => {
    expect(validateDevServerUrl("http://evil.example.com:5173", false)).toBeNull();
    expect(validateDevServerUrl("file:///tmp/x", false)).toBeNull();
    expect(validateDevServerUrl("not a url", false)).toBeNull();
  });
});

describe("window.open policy", () => {
  it("routes http and https targets through the external shell handler", () => {
    expect(isSafeExternalUrl("https://dohc.ai/docs")).toBe(true);
    expect(isSafeExternalUrl("http://dohc.ai/docs")).toBe(true);
  });

  it("never shells out non-http(s) schemes or junk", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("smb://share/x")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });
});
