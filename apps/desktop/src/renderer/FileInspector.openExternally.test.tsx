// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { deferred } from "../testing/deferred";
import { FileInspector } from "./FileInspector";
import { settleAfterUnmount } from "./FileInspector.draft-fixture";
import type { ReportButtonError } from "./collections/useAutomationButtons";

setupFileInspectorTests();

afterEach(async () => {
  cleanup();
  await settleAfterUnmount();
  vi.unstubAllGlobals();
});

describe("Open externally in a view that can't preview its file", () => {
  it("reports a failed open to the shell, with Try again", async () => {
    const openFileExternally = vi.fn(async () => undefined).mockRejectedValueOnce(new Error("open refused"));
    vi.stubGlobal("dohcDesktop", {
      platform: "linux",
      onWorkspaceActivity: vi.fn(() => () => undefined),
      openFileExternally,
    });
    const onButtonError = vi.fn<ReportButtonError>();
    const user = userEvent.setup();
    render(<FileInspector workspaceId="ws-1" path="archive.bin" onButtonError={onButtonError} />);

    await user.click(await screen.findByRole("button", { name: "Open externally" }));
    await waitFor(() => expect(onButtonError).toHaveBeenCalledOnce());
    const [fallback, error, retry] = onButtonError.mock.calls[0]!;
    expect(fallback).toBe("dohc could not open this file externally.");
    expect(error).toEqual(new Error("open refused"));
    retry?.();
    expect(openFileExternally).toHaveBeenCalledTimes(2);
    expect(openFileExternally).toHaveBeenLastCalledWith({ workspaceId: "ws-1", relativePath: "archive.bin" });
  });
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
    ["the person's own file", async () => ({ readOnlyCopy: false })],
    ["a file main can't answer for", async () => { throw new Error("read refused"); }],
  ] as const)("shows nothing for %s", async (_case, answer) => {
    const read = stubBridge(answer);
    render(<FileInspector workspaceId="ws-1" path="archive.bin" />);

    const button = await screen.findByRole("button", { name: "Open externally" });
    await waitFor(() => expect(read).toHaveBeenCalledWith({ workspaceId: "ws-1", relativePath: "archive.bin" }));
    await act(async () => {
      await read.mock.results[0]!.value.catch(() => undefined);
    });
    expect(screen.queryByText("Read-only copy")).toBeNull();
    expect(button.hasAttribute("aria-describedby")).toBe(false);
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
