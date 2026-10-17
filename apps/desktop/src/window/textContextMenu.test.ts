import { EventEmitter } from "node:events";
import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildFromTemplate = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ Menu: { buildFromTemplate } }));

import { installTextContextMenu, textMenuTemplate } from "./textContextMenu";

const noFlags = {
  canUndo: false, canRedo: false, canCut: false, canCopy: false,
  canPaste: false, canDelete: false, canSelectAll: false, canEditRichly: false,
};

function params(overrides: Partial<ContextMenuParams> = {}) {
  return {
    isEditable: false,
    selectionText: "",
    misspelledWord: "",
    dictionarySuggestions: [],
    editFlags: noFlags,
    formControlType: "none" as const,
    ...overrides,
  };
}

function actions() {
  return { replaceMisspelling: vi.fn(), addToDictionary: vi.fn(), lookUp: vi.fn() };
}

// Each item as one readable word: its label, its role, or "-".
function shape(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) =>
    item.type === "separator" ? "-" : item.label ?? `role:${item.role}`,
  );
}

function click(template: MenuItemConstructorOptions[], label: string): void {
  const item = template.find((entry) => entry.label === label);
  if (!item?.click) throw new Error(`no ${label} item`);
  // Electron supplies the arguments; these handlers do not use them.
  Reflect.apply(item.click, item, []);
}

const editable = { isEditable: true, editFlags: { ...noFlags, canPaste: true, canSelectAll: true } };

describe("text menu template", () => {
  it("offers spelling suggestions and Add to dictionary above the edit roles", () => {
    const run = actions();
    const template = textMenuTemplate(params({
      ...editable,
      misspelledWord: "teh",
      selectionText: "teh",
      dictionarySuggestions: ["the", "ten"],
    }), "win32", run);
    expect(shape(template)).toEqual([
      "the", "ten", "Add to dictionary", "-",
      "role:undo", "role:redo", "-",
      "role:cut", "role:copy", "role:paste", "role:selectAll",
    ]);
    click(template, "ten");
    expect(run.replaceMisspelling).toHaveBeenCalledExactlyOnceWith("ten");
    click(template, "Add to dictionary");
    expect(run.addToDictionary).toHaveBeenCalledExactlyOnceWith("teh");
  });

  it("offers only the edit roles in a field with nothing misspelled", () => {
    expect(shape(textMenuTemplate(params(editable), "linux", actions()))).toEqual([
      "role:undo", "role:redo", "-",
      "role:cut", "role:copy", "role:paste", "role:selectAll",
    ]);
  });

  it("enables each edit role only when Chromium says it applies", () => {
    const template = textMenuTemplate(params({
      isEditable: true,
      editFlags: { ...noFlags, canRedo: true, canCopy: true },
    }), "win32", actions());
    const enabled = Object.fromEntries(
      template.filter((item) => item.role).map((item) => [item.role, item.enabled]),
    );
    expect(enabled).toEqual({
      undo: false, redo: true, cut: false, copy: true, paste: false, selectAll: false,
    });
  });

  it("adds Look up and Speech on macOS, naming a shortened selection", () => {
    const run = actions();
    const template = textMenuTemplate(params({
      ...editable,
      misspelledWord: "teh",
      selectionText: "teh",
      dictionarySuggestions: ["the"],
    }), "darwin", run);
    expect(shape(template)).toEqual([
      "the", "Add to dictionary", "-",
      "Look up “teh”", "-",
      "role:undo", "role:redo", "-",
      "role:cut", "role:copy", "role:paste", "role:selectAll", "-",
      "Speech",
    ]);
    expect(template.at(-1)?.submenu).toEqual([{ role: "startSpeaking" }, { role: "stopSpeaking" }]);
    click(template, "Look up “teh”");
    expect(run.lookUp).toHaveBeenCalledOnce();

    const long = textMenuTemplate(params({
      selectionText: "  a selection that runs\nwell past the label  ",
      editFlags: { ...noFlags, canCopy: true },
    }), "darwin", actions());
    expect(long[0]?.label).toBe("Look up “a selection that runs we…”");
  });

  it("offers Copy for a selection outside a field, and Look up only on macOS", () => {
    const selected = params({ selectionText: "plan", editFlags: { ...noFlags, canCopy: true } });
    expect(shape(textMenuTemplate(selected, "win32", actions()))).toEqual(["role:copy"]);
    expect(shape(textMenuTemplate(selected, "darwin", actions()))).toEqual([
      "Look up “plan”", "-", "role:copy", "-", "Speech",
    ]);
  });

  it("opens no menu where there is nothing to edit or copy", () => {
    expect(textMenuTemplate(params(), "darwin", actions())).toEqual([]);
    expect(textMenuTemplate(params({ selectionText: "   " }), "win32", actions())).toEqual([]);
  });

  it("never puts a password field's selection in the menu", () => {
    const template = textMenuTemplate(params({
      ...editable,
      selectionText: "hunter2",
      formControlType: "input-password",
    }), "darwin", actions());
    expect(template.some((item) => item.label?.includes("hunter2"))).toBe(false);
    expect(template.some((item) => item.label === "Speech")).toBe(false);
  });
});

describe("text menu on a window", () => {
  const popup = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    buildFromTemplate.mockReturnValue({ popup });
  });

  function windowWithContents() {
    const contents = Object.assign(new EventEmitter(), {
      replaceMisspelling: vi.fn(),
      showDefinitionForSelection: vi.fn(),
      session: { addWordToSpellCheckerDictionary: vi.fn(() => true) },
    });
    const window = { webContents: contents } as unknown as BrowserWindow;
    installTextContextMenu(window, "darwin");
    return { window, contents };
  }

  const mainFrame = { parent: null };

  it("pops the menu over the window for a right-click in the app's own page", () => {
    const { window, contents } = windowWithContents();
    contents.emit("context-menu", {}, {
      ...params({ ...editable, misspelledWord: "teh", selectionText: "teh", dictionarySuggestions: ["the"] }),
      frame: mainFrame,
    });
    expect(popup).toHaveBeenCalledExactlyOnceWith({ window });
    const template = buildFromTemplate.mock.calls[0]![0] as MenuItemConstructorOptions[];
    click(template, "the");
    expect(contents.replaceMisspelling).toHaveBeenCalledExactlyOnceWith("the");
    click(template, "Add to dictionary");
    expect(contents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledExactlyOnceWith("teh");
    click(template, "Look up “teh”");
    expect(contents.showDefinitionForSelection).toHaveBeenCalledOnce();
  });

  it("leaves app and site preview frames, and empty targets, without a menu", () => {
    const { contents } = windowWithContents();
    const field = params(editable);
    contents.emit("context-menu", {}, { ...field, frame: { parent: mainFrame } });
    contents.emit("context-menu", {}, { ...field, frame: null });
    contents.emit("context-menu", {}, { ...params(), frame: mainFrame });
    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
  });
});
