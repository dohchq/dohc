// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rendererMarks } from "../performance/rendererMarks";
import { editorTabTestId } from "../testPins";
import { WORKSPACE, STORED_STATE, makeBridge, renderShell } from "./DesktopWorkspaceShell.testHarness";
import { WHATS_NEW_TAB_PATH } from "./workbench/workbenchState";

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
