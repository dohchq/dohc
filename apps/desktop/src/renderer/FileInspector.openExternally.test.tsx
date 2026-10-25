// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
