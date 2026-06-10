import { describe, expect, it } from "vitest";
import {
  createMainWindowWebPreferences,
  decideNavigation,
  decideWindowOpen,
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
});

describe("window.open policy", () => {
  it("denies all window.open targets", () => {
    expect(decideWindowOpen("https://dohc.ai/docs").action).toBe("deny");
    expect(decideWindowOpen("file:///etc/passwd").action).toBe("deny");
  });

  it("routes http and https targets through the external shell handler", () => {
    expect(decideWindowOpen("https://dohc.ai/docs").openExternal).toBe(true);
    expect(decideWindowOpen("http://dohc.ai/docs").openExternal).toBe(true);
    expect(decideWindowOpen("http://dohc.ai/docs").action).toBe("deny");
  });

  it("never shells out non-http(s) schemes", () => {
    expect(decideWindowOpen("file:///etc/passwd").openExternal).toBe(false);
    expect(decideWindowOpen("smb://share/x").openExternal).toBe(false);
  });
});
