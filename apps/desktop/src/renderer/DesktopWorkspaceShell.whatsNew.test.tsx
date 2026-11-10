// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rendererMarks } from "../performance/rendererMarks";
import { editorTabTestId } from "../testPins";
import { WORKSPACE, STORED_STATE, makeBridge, renderShell, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";
import { MAX_OPEN_TABS, WHATS_NEW_TAB_PATH } from "./workbench/workbenchState";

const SEEN_KEY = "dohc.whatsNew.seen";
const tab = () => screen.findByTestId(editorTabTestId(WHATS_NEW_TAB_PATH));

describe("What's new after an update", () => {
  beforeEach(() => {
    localStorage.setItem(SEEN_KEY, "an-older-release");
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: { request: (_name: string, take: () => unknown) => Promise.resolve(take()) },
    });
  });
  afterEach(() => {
    localStorage.removeItem(SEEN_KEY);
    Reflect.deleteProperty(navigator, "locks");
  });

  it("opens beside the saved tabs", async () => {
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    expect(await tab()).toBeTruthy();
    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(await screen.findByTestId("whats-new-page")).toBeTruthy();
  });

  // It covers the restored file, so the file never shows to say it is ready.
  it("completes the switch timeline over a restored file", async () => {
    const previousOrdinal = rendererMarks.readSwitchTimeline().at(-1)?.ordinal ?? 0;
    renderShell(makeBridge(Promise.resolve(STORED_STATE)));
    expect(await screen.findByTestId("whats-new-page")).toBeTruthy();
    await waitFor(() => {
      const timeline = rendererMarks.readSwitchTimeline().find((entry) => entry.ordinal > previousOrdinal);
      expect(timeline?.phases["restored-active-surface-ready"]).toEqual(expect.any(Number));
    });
  });

  it("waits for room when the saved tabs are at the limit", async () => {
    const tabs = Array.from({ length: MAX_OPEN_TABS }, (_, index) => `note-${index}.md`);
    const bridge = makeBridge(Promise.resolve(storedStateWithTabs(tabs)));
    renderShell(bridge);
    await waitFor(() => expect(screen.getByTestId("workspace-shell").dataset.ready).toBe("true"));
    expect(await screen.findByTestId("tab-note-0.md")).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId("whats-new-page")).toBeNull();
    expect(screen.queryByTestId(editorTabTestId(WHATS_NEW_TAB_PATH))).toBeNull();
    expect(localStorage.getItem(SEEN_KEY)).toBe("an-older-release");
  });

  it("shows a saved What's new tab at the limit and takes the release", async () => {
    const tabs = [WHATS_NEW_TAB_PATH, ...Array.from({ length: MAX_OPEN_TABS - 1 }, (_, index) => `note-${index}.md`)];
    renderShell(makeBridge(Promise.resolve(storedStateWithTabs(tabs, "note-0.md"))));
    expect(await screen.findByTestId("whats-new-page")).toBeTruthy();
    expect(localStorage.getItem(SEEN_KEY)).not.toBe("an-older-release");
  });

  it("opens once the saved tabs come back after a failed read", async () => {
    const refused = () => new Error("dohc has not finished opening this workspace.");
    const bridge = makeBridge(Promise.resolve(STORED_STATE));
    bridge.getWorkspaceUiState.mockRejectedValueOnce(refused()).mockRejectedValueOnce(refused());
    renderShell(bridge);
    await waitFor(() => expect(bridge.getWorkspaceUiState).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("whats-new-page")).toBeNull();

    act(() => bridge.emitWorkspaceActivity({ workspaceId: WORKSPACE.workspaceId }));

    expect(await screen.findByTestId("tab-b.md")).toBeTruthy();
    expect(await tab()).toBeTruthy();
  });
});
