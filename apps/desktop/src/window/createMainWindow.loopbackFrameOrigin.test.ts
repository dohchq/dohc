import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/dohc-test-user-data",
  },
  BrowserWindow: vi.fn(),
  nativeTheme: { shouldUseDarkColors: false },
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 800 },
    }),
  },
}));

import {
  allowLoopbackFrameOrigin,
  isAllowedLoopbackFrameUrl,
} from "./createMainWindow";

describe("loopback frame origin allowances", () => {
  it("keeps origin releases idempotent so duplicate disposal cannot corrupt refcounts", () => {
    const firstRelease = allowLoopbackFrameOrigin(
      "http://127.0.0.1:4173/panel-a",
    );
    const secondRelease = allowLoopbackFrameOrigin(
      "http://127.0.0.1:4173/panel-b",
    );

    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      true,
    );

    firstRelease();
    firstRelease();
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      true,
    );

    secondRelease();
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      false,
    );
  });

  it("ignores non-loopback preview origins without adding allowances", () => {
    const release = allowLoopbackFrameOrigin("http://example.com:4173/panel");

    expect(isAllowedLoopbackFrameUrl("http://example.com:4173/frame")).toBe(
      false,
    );
    expect(isAllowedLoopbackFrameUrl("http://127.0.0.1:4173/frame")).toBe(
      false,
    );

    release();
    expect(isAllowedLoopbackFrameUrl("http://example.com:4173/frame")).toBe(
      false,
    );
  });
});
