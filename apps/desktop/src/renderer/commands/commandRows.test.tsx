// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MENU_COMMANDS, WORKBENCH_MENU_COMMANDS } from "../../ipc/channels";
import { CommandPalette } from "../CommandPalette";
import { VIEW_IDENTITY } from "../workbench/viewIdentity";
import { appViewId, VIEW_IDS } from "../workbench/workbenchState";
import mainPalette from "./commandRows.main.json";
import {
  isCommandAvailable,
  isStaticCommandId,
  paletteCommandRows,
  pinnedAppCommandId,
  type CommandContext,
  type CommandId,
} from "./commandRows";

afterEach(cleanup);

const context: CommandContext = {
  isShareView: false,
  shareViewWritable: false,
  activeDocumentKind: null,
  pinnedApps: [],
};

describe("command availability", () => {
  it.each([
    [false, false, true],
    [false, true, true],
    [true, false, false],
    [true, true, true],
  ])("collection creation in share=%s writable=%s is %s", (isShareView, shareViewWritable, expected) => {
    const current = { ...context, isShareView, shareViewWritable };
    expect(isCommandAvailable("new-collection", current)).toBe(expected);
    expect(paletteCommandRows(current).some((row) => row.id === "new-collection")).toBe(expected);
  });

  it.each([null, "code", "drawing", "markdown"])("source toggle with active kind %s", (activeDocumentKind) => {
    const current = { ...context, activeDocumentKind };
    expect(isCommandAvailable("toggle-markdown-source", current)).toBe(activeDocumentKind === "markdown");
    expect(paletteCommandRows(current).some((row) => row.id === "toggle-markdown-source")).toBe(activeDocumentKind === "markdown");
  });

  it.each([false, true])("Chats in share=%s", (isShareView) => {
    for (const shareViewWritable of [false, true]) {
      const current = { ...context, isShareView, shareViewWritable };
      expect(isCommandAvailable("show-chats", current)).toBe(!isShareView);
      expect(paletteCommandRows(current).some((row) => row.id === "show-chats")).toBe(!isShareView);
    }
  });

  it("pinned app rows keep encoded ids, labels, order, and membership", () => {
    const pinnedApps = [
      { root: "apps/旅行 plan", label: "Travel" },
      { root: "second#app", label: "Second" },
    ];
    for (const isShareView of [false, true]) {
      const current = { ...context, isShareView, pinnedApps };
      const rows = paletteCommandRows(current);
      const cloudIndex = rows.findIndex((row) => row.id === "connect-cloud");
      expect(rows.slice(cloudIndex - 2, cloudIndex).map(({ id, label }) => ({ id, label }))).toEqual(
        pinnedApps.map((app) => ({ id: `show-${appViewId(app.root)}`, label: `View: ${app.label}` })),
      );
      for (const app of pinnedApps) expect(isCommandAvailable(pinnedAppCommandId(app.root), current)).toBe(true);
    }
    expect(isCommandAvailable(pinnedAppCommandId(pinnedApps[0].root), context)).toBe(false);
    expect(paletteCommandRows(context).some((row) => row.availability === "pinnedApp")).toBe(false);
  });

  it("preserves unconditional write offers for later UI work", () => {
    const readOnlyShare = { ...context, isShareView: true };
    for (const id of ["new-file", "new-drawing", "new-folder", "import-files"] as const) {
      expect(isCommandAvailable(id, readOnlyShare)).toBe(true);
    }
  });
});

describe("command inventory", () => {
  it("every application menu id names a row or opens the palette", () => {
    const unknownIds = MENU_COMMANDS.filter((id) => id !== "command-palette" && !isStaticCommandId(id));
    expect(unknownIds).toEqual([]);
  });

  it("checks the five global workbench command ids without changing their dispatch", () => {
    const globalCommands = [
      "connect-cloud", "settings", "check-updates", "install-update", "toggle-theme",
    ] as const satisfies readonly (CommandId & (typeof WORKBENCH_MENU_COMMANDS)[number])[];
    for (const id of globalCommands) expect(isStaticCommandId(id)).toBe(true);
    expect(isStaticCommandId("open-history")).toBe(false);
  });

  it("keeps each built-in view label and order aligned with the rail", () => {
    const rows = paletteCommandRows(context).filter((row) => row.id.startsWith("show-"));
    expect(rows.map(({ id, label }) => ({ id, label }))).toEqual(
      VIEW_IDS.map((view) => ({ id: `show-${view}`, label: `View: ${VIEW_IDENTITY[view].label}` })),
    );
  });

  it("tags only the matching capability already issued on this base", () => {
    expect(paletteCommandRows(mainPalette.context).filter((row) => row.capabilityId).map(({ id, capabilityId }) => ({ id, capabilityId }))).toEqual([
      { id: "new-folder", capabilityId: "folder.create" },
    ]);
  });

  it("rejects an unknown command rather than treating it as unavailable", () => {
    expect(() => isCommandAvailable("fake-command" as CommandId, context)).toThrow("Unknown command: fake-command");
  });

  it("renders main's generated labels in main's order for the fixed context", () => {
    const rows = paletteCommandRows(mainPalette.context);
    expect(rows.map(({ id, label }) => ({ id, label }))).toEqual(mainPalette.rows);
    Element.prototype.scrollIntoView = vi.fn();
    render(<CommandPalette commands={rows.map((row) => ({ ...row, run: vi.fn() }))} onClose={vi.fn()} />);
    expect(screen.getAllByRole("option").map((row) => row.textContent)).toEqual(mainPalette.rows.map((row) => row.label));
  });
});
