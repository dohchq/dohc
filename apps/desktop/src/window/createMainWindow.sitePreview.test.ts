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
  allowSitePreviewOrigin,
  isAllowedSitePreviewUrl,
} from "./createMainWindow";

describe("site preview origin allowances", () => {
  it("keeps origin releases idempotent so duplicate disposal cannot corrupt refcounts", () => {
    const firstRelease = allowSitePreviewOrigin("http://127.0.0.1:4173/site-a");
    const secondRelease = allowSitePreviewOrigin("http://127.0.0.1:4173/site-b");

    expect(isAllowedSitePreviewUrl("http://127.0.0.1:4173/frame")).toBe(true);

    firstRelease();
    firstRelease();
    expect(isAllowedSitePreviewUrl("http://127.0.0.1:4173/frame")).toBe(true);

    secondRelease();
    expect(isAllowedSitePreviewUrl("http://127.0.0.1:4173/frame")).toBe(false);
  });

  it("ignores non-loopback preview origins without adding allowances", () => {
    const release = allowSitePreviewOrigin("http://example.com:4173/site");

    expect(isAllowedSitePreviewUrl("http://example.com:4173/frame")).toBe(false);
    expect(isAllowedSitePreviewUrl("http://127.0.0.1:4173/frame")).toBe(false);

    release();
    expect(isAllowedSitePreviewUrl("http://example.com:4173/frame")).toBe(false);
  });
});
