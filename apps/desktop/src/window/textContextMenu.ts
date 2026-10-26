import {
  Menu,
  type BrowserWindow,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron";

type TextMenuParams = Pick<
  ContextMenuParams,
  | "isEditable"
  | "selectionText"
  | "misspelledWord"
  | "dictionarySuggestions"
  | "editFlags"
  | "formControlType"
>;

export interface TextMenuActions {
  replaceMisspelling(suggestion: string): void;
  addToDictionary(word: string): void;
  // macOS only: the system's definition panel for the selection.
  lookUp(): void;
}

const LOOK_UP_CHARS = 24;

function lookUpLabel(selection: string): string {
  const text = selection.replace(/\s+/g, " ");
  return `Look up “${text.length > LOOK_UP_CHARS ? `${text.slice(0, LOOK_UP_CHARS)}…` : text}”`;
}

// The submenus of the same name in macOS's Edit menu.
const SUBSTITUTIONS: MenuItemConstructorOptions = {
  label: "Substitutions",
  submenu: [
    { role: "showSubstitutions" },
    { type: "separator" },
    { role: "toggleSmartQuotes" },
    { role: "toggleSmartDashes" },
    { role: "toggleTextReplacement" },
  ],
};
const SPEECH: MenuItemConstructorOptions = {
  label: "Speech",
  submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
};

// The right-click menu for text: spelling first, then Look up on macOS, then
// the edit roles Chromium says apply. macOS text menus leave out Undo and
// Redo, add Paste and Match Style, and end with Substitutions for a field
// and Speech for a selection, as Edit does. Empty when the target is neither
// editable nor selected, so no menu opens.
export function textMenuTemplate(
  params: TextMenuParams,
  platform: NodeJS.Platform,
  actions: TextMenuActions,
): MenuItemConstructorOptions[] {
  const mac = platform === "darwin";
  const flags = params.editFlags;
  // Selected spaces still copy, but there is nothing to look up or speak.
  // A password never leaves its field, not even into a menu label, and
  // Chromium makes no substitutions in it.
  const password = params.formControlType === "input-password";
  const words = password ? "" : params.selectionText.trim();
  const misspelled = params.isEditable ? params.misspelledWord : "";
  const groups: MenuItemConstructorOptions[][] = [
    misspelled
      ? [
          ...params.dictionarySuggestions.map((suggestion) => ({
            label: suggestion,
            click: () => actions.replaceMisspelling(suggestion),
          })),
          { label: "Add to dictionary", click: () => actions.addToDictionary(misspelled) },
        ]
      : [],
    mac && words ? [{ label: lookUpLabel(words), click: () => actions.lookUp() }] : [],
    ...(params.isEditable
      ? [
          mac
            ? []
            : [
                { role: "undo" as const, enabled: flags.canUndo },
                { role: "redo" as const, enabled: flags.canRedo },
              ],
          [
            { role: "cut" as const, enabled: flags.canCut },
            { role: "copy" as const, enabled: flags.canCopy },
            { role: "paste" as const, enabled: flags.canPaste },
            ...(mac && flags.canPaste ? [{ role: "pasteAndMatchStyle" as const }] : []),
            { role: "selectAll" as const, enabled: flags.canSelectAll },
          ],
        ]
      : params.selectionText
        ? [[{ role: "copy" as const, enabled: flags.canCopy }]]
        : []),
    [
      ...(mac && params.isEditable && !password ? [SUBSTITUTIONS] : []),
      ...(mac && words ? [SPEECH] : []),
    ],
  ];
  return groups
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [{ type: "separator" as const }, ...group]));
}

// Text fields and selections get their menu here, built from Chromium's own
// facts about the right-click. The renderer's workbench menus cancel the DOM
// event, and a cancelled event never reaches this handler, so the two never
// both open.
export function installTextContextMenu(
  window: BrowserWindow,
  platform: NodeJS.Platform = process.platform,
): void {
  const contents = window.webContents;
  contents.on("context-menu", (_event, params) => {
    // Only the window's own page gets the menu. Any other frame, such as an
    // app or site preview, keeps Electron's default, which is no menu.
    if (!params.frame || params.frame !== contents.mainFrame) return;
    const template = textMenuTemplate(params, platform, {
      replaceMisspelling: (suggestion) => contents.replaceMisspelling(suggestion),
      addToDictionary: (word) => contents.session.addWordToSpellCheckerDictionary(word),
      lookUp: () => contents.showDefinitionForSelection(),
    });
    if (template.length === 0) return;
    // Given the frame, macOS adds its own items for the target, such as
    // Services, Writing Tools and AutoFill. A password field's menu leaves
    // them out, as macOS does for a secure text field.
    const password = params.formControlType === "input-password";
    Menu.buildFromTemplate(template).popup(password ? { window } : { window, frame: params.frame });
  });
}
