// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";
import { TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";

setupFileInspectorTests();

describe("read-only reason on the text and CSV chips", () => {
  const bridgeMock = {
    platform: "linux" as const,
    onWorkspaceActivity: vi.fn(() => () => undefined),
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(async () => ({
      status: "written",
      contentHash: TEST_CONTENT_HASH,
    })),
    listWorkspaceFiles: vi.fn(async () => ({ files: [], folders: [] })),
    readWorkspaceDatabase: vi.fn(async () => ({ tables: [] })),
    getWorkspaceSettings: vi.fn(async () => ({
      settings: DEFAULT_WORKSPACE_SETTINGS,
      source: "default" as const,
    })),
  };

  beforeEach(() => {
    stubEditorGlobals();
    vi.stubGlobal("dohcDesktop", bridgeMock);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const PAGE_SHARE = "This page is shared with you to read.";
  const TOO_LARGE = "This file is too large to edit in dohc.";

  it.each([false, true])(
    "describes why the Markdown toggle is disabled, truncated: %s",
    async (truncated) => {
      bridgeMock.readWorkspaceText.mockResolvedValue(
        truncated
          ? { text: "# Plan\n", truncated: true, contentHash: null }
          : { text: "# Plan\n", truncated: false, contentHash: TEST_CONTENT_HASH },
      );
      const user = userEvent.setup();
      render(<FileInspector workspaceId="ws-1" path="plan.md" readOnly={!truncated} />);
      const toggle = await screen.findByRole("button", {
        name: "Edit",
        description: truncated ? TOO_LARGE : PAGE_SHARE,
      });
      expect(toggle.getAttribute("title")).toBe(truncated ? TOO_LARGE : PAGE_SHARE);
      toggle.focus();
      await user.keyboard("{Enter} ");
      await user.click(toggle);
      expect(screen.queryByTestId("markdown-editor")).toBeNull();
      expect(bridgeMock.writeWorkspaceText).not.toHaveBeenCalled();
    },
  );
});
