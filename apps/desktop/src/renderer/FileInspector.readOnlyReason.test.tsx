// @vitest-environment jsdom
import { setupFileInspectorTests } from "./FileInspector.environment-fixture";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileInspector } from "./FileInspector";
import { DEFAULT_WORKSPACE_SETTINGS } from "../workspaces/workspaceSettings";
import type { DohcDesktopBridge } from "../ipc/bridgeContract";
import { stubEditorGlobals } from "./FileInspector.editor-fixture";
import { TEST_CONTENT_HASH } from "./FileInspector.draft-fixture";

setupFileInspectorTests();

// The text and CSV editors are disabled for two different reasons, and the
// chip must name the one that applies: a read-only share is not a file that
// was too large to read.
describe("read-only reason on the text and CSV chips", () => {
  const bridgeMock = {
    platform: "linux" as const,
    readWorkspaceText: vi.fn<DohcDesktopBridge["readWorkspaceText"]>(),
    writeWorkspaceText: vi.fn<DohcDesktopBridge["writeWorkspaceText"]>(
      async () => ({ status: "written", contentHash: TEST_CONTENT_HASH }),
    ),
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

  const SHARE = "This document is shared with you to read.";
  const TOO_LARGE = "This file is too large to edit in dohc.";

  for (const [path, testId, label] of [
    ["notes.txt", "view-text-save-state", "text"],
    ["main.ts", "view-text-save-state", "text"],
    ["index.html", "view-text-save-state", "text"],
    ["config.yaml", "view-text-save-state", "text"],
    ["config.json", "view-json-save-state", "json"],
    ["rows.csv", "csv-save-state", "data"],
  ] as const) {
    it(`${path}: a read-only share says so`, async () => {
      bridgeMock.readWorkspaceText.mockResolvedValue({ text: "a,b\n", truncated: false, contentHash: TEST_CONTENT_HASH });
      render(<FileInspector workspaceId="ws-1" path={path} readOnly />);
      const chip = await screen.findByTestId(testId);
      expect(screen.getByTestId("file-inspector").querySelector("header")?.textContent).toBe(path + label);
      expect(chip.textContent).toBe("Read-only");
      expect(chip.getAttribute("title")).toBe(SHARE);
      expect(chip.dataset.state).toBe("saved");
    });

    it(`${path}: a bounded read says the file is too large`, async () => {
      bridgeMock.readWorkspaceText.mockResolvedValue({ text: "a,b\n", truncated: true, contentHash: null });
      render(<FileInspector workspaceId="ws-1" path={path} />);
      const chip = await screen.findByTestId(testId);
      expect(screen.getByTestId("file-inspector").querySelector("header")?.textContent).toBe(path + label);
      expect(chip.textContent).toBe("Read-only");
      expect(chip.getAttribute("title")).toBe(TOO_LARGE);
      expect(chip.dataset.state).toBe("saved");
    });
  }
});
