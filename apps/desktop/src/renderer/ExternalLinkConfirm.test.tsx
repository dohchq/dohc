// @vitest-environment jsdom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "./bridge";
import { ExternalLinkConfirm } from "./ExternalLinkConfirm";
import { openLinkExternally } from "./editor/linkMenu";

vi.mock("./bridge", () => ({ bridge: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.mocked(bridge).mockReset();
});

/** Installs a bridge whose workspace settings answer `confirmExternalLinks`
 *  as given, or reject when `confirm` is the string "unreadable". */
function mockBridge(confirm: boolean | "unreadable"): {
  openExternalUrl: ReturnType<typeof vi.fn>;
} {
  const openExternalUrl = vi.fn().mockResolvedValue(undefined);
  const getWorkspaceSettings =
    confirm === "unreadable"
      ? vi.fn().mockRejectedValue(new Error("settings file is corrupt"))
      : vi.fn().mockResolvedValue({
          settings: { privacy: { confirmExternalLinks: confirm } },
        });
  vi.mocked(bridge).mockReturnValue({
    openExternalUrl,
    getWorkspaceSettings,
  } as unknown as ReturnType<typeof bridge>);
  return { openExternalUrl };
}

/** Drains the promise chain between openLinkExternally and the rendered
 *  dialog (settings read → confirm decision → setState). */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ExternalLinkConfirm", () => {
  it("setting on: asks first, and opens only after the user confirms", async () => {
    const { openExternalUrl } = mockBridge(true);
    render(<ExternalLinkConfirm workspaceId="w1" />);

    const opening = openLinkExternally("https://example.com/docs");
    await flush();

    // The kill: without the gate in openLinkExternally, the bridge is already
    // called here and no dialog exists.
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("external-link-confirm")).toBeTruthy();
    expect(screen.getByTestId("external-link-confirm-url").textContent).toBe(
      "https://example.com/docs",
    );

    await act(async () => {
      fireEvent.click(screen.getByTestId("external-link-confirm-open"));
      await opening;
    });

    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });
    expect(screen.queryByTestId("external-link-confirm")).toBeNull();
  });

  it("setting on: cancel opens nothing", async () => {
    const { openExternalUrl } = mockBridge(true);
    render(<ExternalLinkConfirm workspaceId="w1" />);

    const opening = openLinkExternally("https://example.com/docs");
    await flush();
    expect(screen.getByTestId("external-link-confirm")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("external-link-confirm-cancel"));
      await opening;
    });

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(screen.queryByTestId("external-link-confirm")).toBeNull();
  });

  it("setting on: dismissing the dialog with Escape opens nothing", async () => {
    const { openExternalUrl } = mockBridge(true);
    render(<ExternalLinkConfirm workspaceId="w1" />);

    const opening = openLinkExternally("https://example.com/docs");
    await flush();
    expect(screen.getByTestId("external-link-confirm")).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document, { key: "Escape" });
      await opening;
    });

    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("setting off: opens immediately and never asks", async () => {
    const { openExternalUrl } = mockBridge(false);
    render(<ExternalLinkConfirm workspaceId="w1" />);

    await act(async () => {
      await openLinkExternally("https://example.com/docs");
    });

    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });
    expect(screen.queryByTestId("external-link-confirm")).toBeNull();
  });

  it("an unreadable settings file asks instead of opening silently", async () => {
    const { openExternalUrl } = mockBridge("unreadable");
    render(<ExternalLinkConfirm workspaceId="w1" />);

    const opening = openLinkExternally("https://example.com/docs");
    await flush();

    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(screen.getByTestId("external-link-confirm")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("external-link-confirm-cancel"));
      await opening;
    });
  });

  it("unmounting the workspace shell cancels a waiting link", async () => {
    const { openExternalUrl } = mockBridge(true);
    const view = render(<ExternalLinkConfirm workspaceId="w1" />);

    const opening = openLinkExternally("https://example.com/docs");
    await flush();
    expect(screen.getByTestId("external-link-confirm")).toBeTruthy();

    await act(async () => {
      view.unmount();
      await opening;
    });

    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("with no workspace shell mounted, an open is not gated", async () => {
    const { openExternalUrl } = mockBridge(true);

    await act(async () => {
      await openLinkExternally("https://example.com/docs");
    });

    expect(openExternalUrl).toHaveBeenCalledWith({
      url: "https://example.com/docs",
    });
  });
});

// A structural pin, not a behavior pin: the behavior pins above cover every
// surface only because every surface reaches openLinkExternally. This is what
// fails when a new surface calls the bridge directly and skips the confirm —
// the exact bypass #805 exists to prevent.
describe("external-open routing", () => {
  it("only openLinkExternally calls the openExternalUrl bridge", () => {
    // jsdom does not give this module a file: URL, so resolve from the
    // package root vitest runs in.
    const rendererRoot = join(process.cwd(), "src", "renderer");
    const callers: string[] = [];

    function walk(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
          continue;
        }
        // An invocation, not a prose mention of the channel in a comment.
        if (/\bopenExternalUrl\s*\(/.test(readFileSync(full, "utf8"))) {
          callers.push(relative(rendererRoot, full).replaceAll("\\", "/"));
        }
      }
    }

    walk(rendererRoot);

    expect(callers.sort()).toEqual(["editor/linkMenu.tsx"]);
  });
});
