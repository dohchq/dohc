// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EDITOR_MENU_COMMANDS, MENU_COMMANDS, WORKBENCH_MENU_COMMANDS, isEditorMenuCommand } from "../../ipc/channels";
import type { ShareViewWriteScope } from "../../workspaces/shareWriteGate";
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
  shareView: null,
  activeDocumentKind: null,
  pinnedApps: [],
};
const viewShare: ShareViewWriteScope = { access: "view", ended: false };
const editShare: ShareViewWriteScope = { access: "edit", ended: false };
// In palette order.
const CREATE_COMMANDS: readonly CommandId[] = ["new-file", "new-file-at-path", "new-drawing", "new-folder", "new-collection", "import-files"];

describe("command availability", () => {
  it.each<[string, ShareViewWriteScope | null, readonly CommandId[]]>([
    ["an ordinary workspace", null, CREATE_COMMANDS],
    ["an Edit share view", editShare, ["new-file", "new-file-at-path", "new-drawing", "new-collection", "import-files"]],
    ["a Comment share view", { access: "comment", ended: false }, []],
    ["a View share view", viewShare, []],
    ["an ended Edit share view", { access: "edit", ended: true }, []],
    ["a share view whose grant cannot be read", { access: null, ended: false }, []],
  ])("%s offers only the creates and imports its handlers take", (_name, shareView, expected) => {
    const current = { ...context, shareView };
    expect(CREATE_COMMANDS.filter((id) => isCommandAvailable(id, current))).toEqual(expected);
    expect(paletteCommandRows(current).map((row) => row.id).filter((id) => CREATE_COMMANDS.includes(id))).toEqual(expected);
  });

  it.each([null, "code", "drawing", "markdown"])("source toggle with active kind %s", (activeDocumentKind) => {
    const current = { ...context, activeDocumentKind };
    expect(isCommandAvailable("toggle-markdown-source", current)).toBe(activeDocumentKind === "markdown");
    expect(paletteCommandRows(current).some((row) => row.id === "toggle-markdown-source")).toBe(activeDocumentKind === "markdown");
  });

  it.each([null, viewShare, editShare])("Chats with share view %j", (shareView) => {
    const current = { ...context, shareView };
    expect(isCommandAvailable("show-chats", current)).toBe(shareView === null);
    expect(paletteCommandRows(current).some((row) => row.id === "show-chats")).toBe(shareView === null);
  });

  it("pinned app rows keep encoded ids, labels, order, and membership", () => {
    const pinnedApps = [
      { root: "apps/旅行 plan", label: "Travel" },
      { root: "second#app", label: "Second" },
    ];
    for (const shareView of [null, viewShare]) {
      const current = { ...context, shareView, pinnedApps };
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
});

describe("command inventory", () => {
  it("every application menu id names a row, opens the palette, or goes to the focused editor", () => {
    const unknownIds = MENU_COMMANDS.filter((id) => id !== "command-palette" && !isStaticCommandId(id) && !isEditorMenuCommand(id));
    expect(unknownIds).toEqual([]);
    expect(EDITOR_MENU_COMMANDS.filter((id) => isStaticCommandId(id))).toEqual([]);
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
