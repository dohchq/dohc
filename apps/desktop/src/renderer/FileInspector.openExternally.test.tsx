// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { FileInspector } from "./FileInspector";
import { settleAfterUnmount } from "./FileInspector.draft-fixture";


setupFileInspectorTests();

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  vi.unstubAllGlobals();
});


describe("Read-only copy beside Open externally", () => {
  function stubBridge(readExternalOpen: DohcDesktopBridge["readExternalOpen"]) {
    const read = vi.fn(readExternalOpen);
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      onWorkspaceActivity: vi.fn(() => () => undefined),
      openFileExternally: vi.fn(async () => undefined),
      readExternalOpen: read,
    });
    return read;
  }

  it("follows the control for a file from someone else, as its description and not its name", async () => {
    stubBridge(async () => ({ readOnlyCopy: true }));
    render(<FileInspector workspaceId="ws-1" path="archive.bin" />);

    const words = await screen.findByText("Read-only copy");
    const button = screen.getByRole("button", { name: "Open externally" });
    expect(button.getAttribute("aria-describedby")).toBe(words.id);
    expect(button.contains(words)).toBe(false);
    expect(words.hasAttribute("title")).toBe(false);
    expect(words.previousElementSibling?.getAttribute("aria-hidden")).toBe("true");
  });


  it.each([
    ["another file", "ws-1", "other.bin"],
    ["the same path in another workspace", "ws-2", "archive.bin"],
  ] as const)("never shows a late answer for one file on %s", async (_case, workspaceId, path) => {
    const late = deferred<{ readOnlyCopy: boolean }>();
    const read = stubBridge(async (input) =>
      input.workspaceId === "ws-1" && input.relativePath === "archive.bin" ? late.promise : { readOnlyCopy: false });
    const { rerender } = render(<FileInspector workspaceId="ws-1" path="archive.bin" />);
    await waitFor(() => expect(read).toHaveBeenCalledOnce());

    rerender(<FileInspector workspaceId={workspaceId} path={path} />);
    await waitFor(() => expect(read).toHaveBeenLastCalledWith({ workspaceId, relativePath: path }));
    await act(async () => {
      late.resolve({ readOnlyCopy: true });
      await late.promise;
    });
    await screen.findByRole("button", { name: "Open externally" });
    expect(screen.queryByText("Read-only copy")).toBeNull();
  });
});
