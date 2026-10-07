// @vitest-environment jsdom
import "./DesktopWorkspaceShell.testSupport";
import { act, screen, waitFor } from "@testing-library/react";
import { it, expect, vi } from "vitest";
import type * as Y from "yjs";
import { makeBridge, renderShell, storedStateWithTabs } from "./DesktopWorkspaceShell.testHarness";
import { harnessBridge } from "./collab/engineDocSaveStateTestHarness";

const counts = vi.hoisted(() => ({ shell: 0, titlebar: 0, tabs: 0, activity: 0, doc: null as Y.Doc | null }));
vi.mock("./shell/useEditorRegistry", async (original) => {
  const actual = await original<typeof import("./shell/useEditorRegistry")>();
  return { ...actual, useEditorRegistry(...args: Parameters<typeof actual.useEditorRegistry>) {
    counts.shell++;
    return actual.useEditorRegistry(...args);
  } };
});
vi.mock("./shell/ShellTitlebar", async (original) => {
  const actual = await original<typeof import("./shell/ShellTitlebar")>();
  return { ...actual, ShellTitlebar(...args: Parameters<typeof actual.ShellTitlebar>) {
    counts.titlebar++;
    return actual.ShellTitlebar(...args);
  } };
});
vi.mock("./workbench/EditorTabs", async (original) => {
  const actual = await original<typeof import("./workbench/EditorTabs")>();
  return { ...actual, EditorTabs(...args: Parameters<typeof actual.EditorTabs>) {
    counts.tabs++;
    return <actual.EditorTabs {...args[0]} />;
  } };
});
vi.mock("./collab/useEngineDoc", async (original) => {
  const actual = await original<typeof import("./collab/useEngineDoc")>();
  return { ...actual, useEngineDoc(...args: Parameters<typeof actual.useEngineDoc>) {
    const state = actual.useEngineDoc(...args);
    if (state.doc) counts.doc = state.doc;
    return state;
  } };
});

it("keeps 30 keystrokes and their settles within dirty-flip shell, tab and titlebar renders, without activity", async () => {
  const engine = harnessBridge();
  const bridge = Object.assign(makeBridge(Promise.resolve(storedStateWithTabs(["a.md"], "a.md"))), engine.api);
  const subscribe = bridge.onWorkspaceActivity;
  bridge.onWorkspaceActivity = vi.fn((listener) => subscribe((event) => { counts.activity++; listener(event); }));
  renderShell(bridge);
  await screen.findByTestId("view-markdown");
  await waitFor(() => expect(counts.doc).not.toBeNull());
  await act(async () => {});
  vi.useFakeTimers();
  try {
    counts.shell = counts.titlebar = counts.tabs = counts.activity = 0;
    for (let round = 0; round < 3; round++) {
      for (let key = 0; key < 10; key++) {
        const before = { shell: counts.shell, tabs: counts.tabs, titlebar: counts.titlebar };
        await act(async () => {
          const text = counts.doc!.getText("plainText");
          text.insert(text.length, "!");
        });
        if (key > 0) expect({ shell: counts.shell, tabs: counts.tabs, titlebar: counts.titlebar }).toEqual(before);
      }
      await act(async () => { await vi.advanceTimersByTimeAsync(32); });
      const before = { shell: counts.shell, tabs: counts.tabs, titlebar: counts.titlebar };
      engine.emit("saved", engine.applied.at(-1)!.seq);
      await act(async () => {});
      expect(counts.shell - before.shell).toBeLessThanOrEqual(1);
      expect(counts.tabs - before.tabs).toBeLessThanOrEqual(1);
      expect(counts.titlebar - before.titlebar).toBeLessThanOrEqual(1);
    }
    expect(counts.activity).toBe(0);
    expect(counts.shell).toBeLessThanOrEqual(6);
    expect(counts.tabs).toBeLessThanOrEqual(6);
    expect(counts.titlebar).toBeLessThanOrEqual(6);
  } finally { vi.useRealTimers(); }
});
