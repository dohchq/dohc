import type { StaticCommandId } from "../renderer/commands/commandRows";

// These ids already have owners outside the palette's command rows.
type EditorShortcutId = "editor-mac-backspace" | "editor-mac-delete" | "editor-mac-line-start" | "editor-mac-line-end" | "editor-link" | "editor-bold" | "editor-undo" | "editor-redo" | "editor-find" | "editor-replace"
  | "editor-paragraph" | "editor-heading-1" | "editor-heading-2" | "editor-heading-3" | "editor-heading-4" | "editor-heading-5" | "editor-heading-6"
  | "editor-delete-word" | "editor-backspace-word" | "editor-hard-break" | "editor-select-all" | "editor-highlight" | "editor-blockquote" | "editor-bullet-list"
  | "editor-code" | "editor-code-block" | "editor-italic" | "editor-strike" | "editor-underline" | "editor-ordered-list" | "editor-task-list";
type OwnedShortcutId = "command-palette" | "close-window" | "quit" | "history-restore-undo"
  | EditorShortcutId
  | "palette-move" | "palette-accept" | "palette-dismiss" | "find-next" | "find-previous" | "find-again-next" | "find-again-previous" | "find-close" | "dev-panel";
export type ShortcutOwner = "history-restore" | "shell" | "main" | "native" | "document" | "editor" | "palette" | "find" | "find-field" | "dev";
interface ShortcutKeys {
  accelerators: readonly string[];
  // Shown instead of the text derived from the first accelerator.
  keys?: readonly string[];
}
interface ShortcutDefinition extends ShortcutKeys {
  owner: ShortcutOwner;
  // Replaces the row's keys on macOS, where its convention differs.
  mac?: Partial<ShortcutKeys>;
  // What another keyboard layout reports for one of the row's chords, such as
  // Я for Z on a Russian layout. The row answers them; Settings does not list them.
  layoutAliases?: readonly string[];
  macOptionCode?: string;
  // The row exists only on these platforms.
  platforms?: readonly ("darwin" | "linux" | "win32")[];
}
type ShortcutEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

// Settings > Keyboard lists the rows in this order, under their owner's heading.
export const SHORTCUTS = {
  "command-palette": { owner: "shell", accelerators: ["CommandOrControl+Shift+P", "CommandOrControl+K"] },
  "quick-open": { owner: "shell", accelerators: ["CommandOrControl+P"] },
  "new-file": { owner: "shell", accelerators: ["CommandOrControl+N"] },
  "settings": { owner: "shell", accelerators: ["CommandOrControl+,"] },
  "toggle-sidebar": { owner: "shell", accelerators: ["CommandOrControl+B"] },
  "toggle-about": { owner: "shell", accelerators: ["CommandOrControl+Alt+B"], macOptionCode: "KeyB" },
  "new-editor-group-right": { owner: "shell", accelerators: ["CommandOrControl+\\"] },
  // ⌃Tab everywhere, as in browsers. macOS adds ⇧⌘] as Safari does, and
  // Windows and Linux add Ctrl+PageDown as VS Code does.
  "next-tab": { owner: "shell", accelerators: ["Ctrl+Tab", "Ctrl+PageDown"], mac: { accelerators: ["Ctrl+Tab", "CommandOrControl+Shift+]"] } },
  "previous-tab": { owner: "shell", accelerators: ["Ctrl+Shift+Tab", "Ctrl+PageUp"], mac: { accelerators: ["Ctrl+Shift+Tab", "CommandOrControl+Shift+["] } },
  "close-tab": { owner: "shell", accelerators: ["CommandOrControl+W"] },
  "close-window": { owner: "native", accelerators: ["CommandOrControl+Shift+W"] },
  // macOS's app menu and Linux's File menu quit, as their apps do. Windows apps
  // quit with Alt+F4, and the tray icon Windows shows has Quit dohc.
  "quit": { owner: "native", platforms: ["darwin", "linux"], accelerators: ["CommandOrControl+Q"] },
  "zoom-in": { owner: "main", accelerators: ["CommandOrControl+=", "CommandOrControl+Plus", "CommandOrControl+numadd"] },
  "zoom-out": { owner: "main", accelerators: ["CommandOrControl+-", "CommandOrControl+numsub"] },
  "zoom-reset": { owner: "main", accelerators: ["CommandOrControl+0"] },
  "history-restore-undo": { owner: "history-restore", accelerators: ["CommandOrControl+Z"] },
  "dev-panel": { owner: "dev", accelerators: ["CommandOrControl+Shift+D"] },
  "toggle-markdown-source": { owner: "document", accelerators: ["CommandOrControl+/"] },
  "editor-undo": { owner: "editor", accelerators: ["CommandOrControl+Z"], layoutAliases: ["CommandOrControl+Я"] },
  "editor-redo": { owner: "editor", accelerators: ["CommandOrControl+Shift+Z", "CommandOrControl+Y"], layoutAliases: ["CommandOrControl+Shift+Я"] },
  "editor-select-all": { owner: "editor", accelerators: ["CommandOrControl+A"] },
  "editor-bold": { owner: "editor", accelerators: ["CommandOrControl+B"] },
  "editor-italic": { owner: "editor", accelerators: ["CommandOrControl+I"] },
  "editor-underline": { owner: "editor", accelerators: ["CommandOrControl+U"] },
  "editor-strike": { owner: "editor", accelerators: ["CommandOrControl+Shift+S"] },
  "editor-code": { owner: "editor", accelerators: ["CommandOrControl+E"] },
  "editor-highlight": { owner: "editor", accelerators: ["CommandOrControl+Shift+H"] },
  "editor-link": { owner: "editor", accelerators: ["CommandOrControl+K"] },
  "editor-paragraph": { owner: "editor", accelerators: ["CommandOrControl+Alt+0"] },
  "editor-heading-1": { owner: "editor", accelerators: ["CommandOrControl+Alt+1"] },
  "editor-heading-2": { owner: "editor", accelerators: ["CommandOrControl+Alt+2"] },
  "editor-heading-3": { owner: "editor", accelerators: ["CommandOrControl+Alt+3"] },
  "editor-heading-4": { owner: "editor", accelerators: ["CommandOrControl+Alt+4"] },
  "editor-heading-5": { owner: "editor", accelerators: ["CommandOrControl+Alt+5"] },
  "editor-heading-6": { owner: "editor", accelerators: ["CommandOrControl+Alt+6"] },
  "editor-bullet-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+8"] },
  "editor-ordered-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+7"] },
  "editor-task-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+9"] },
  "editor-blockquote": { owner: "editor", accelerators: ["CommandOrControl+Shift+B"] },
  "editor-code-block": { owner: "editor", accelerators: ["CommandOrControl+Alt+C"] },
  "editor-hard-break": { owner: "editor", accelerators: ["CommandOrControl+Enter"] },
  "editor-backspace-word": { owner: "editor", accelerators: ["CommandOrControl+Backspace"] },
  "editor-mac-backspace": { owner: "editor", platforms: ["darwin"], accelerators: ["Ctrl+H", "Alt+Backspace"] },
  "editor-delete-word": { owner: "editor", accelerators: ["CommandOrControl+Delete"] },
  "editor-mac-delete": { owner: "editor", platforms: ["darwin"], accelerators: ["Ctrl+D", "Ctrl+Alt+Backspace", "Alt+Delete", "Alt+D"] },
  "editor-mac-line-start": { owner: "editor", platforms: ["darwin"], accelerators: ["Ctrl+A"] },
  "editor-mac-line-end": { owner: "editor", platforms: ["darwin"], accelerators: ["Ctrl+E"] },
  "editor-find": { owner: "editor", accelerators: ["CommandOrControl+F"] },
  // macOS keeps ⌘H for Hide, so Replace takes ⌥⌘F there, as in Xcode and Pages.
  "editor-replace": { owner: "editor", accelerators: ["CommandOrControl+H"], mac: { accelerators: ["CommandOrControl+Alt+F"] } },
  // While the find bar has a query, from the bar or the document: ⌘G on
  // macOS, as in Safari and TextEdit, and F3 elsewhere, as in VS Code. The
  // find feature answers them itself; no editor keymap mounts them.
  "find-again-next": { owner: "find", accelerators: ["F3"], mac: { accelerators: ["CommandOrControl+G"] } },
  "find-again-previous": { owner: "find", accelerators: ["Shift+F3"], mac: { accelerators: ["CommandOrControl+Shift+G"] } },
  // The find field answers these itself; Escape also closes from the replace
  // field. There Enter replaces the match, and in the document it edits text.
  "find-next": { owner: "find-field", accelerators: ["Enter"] },
  "find-previous": { owner: "find-field", accelerators: ["Shift+Enter"] },
  "find-close": { owner: "find-field", accelerators: ["Escape"] },
  "palette-move": { owner: "palette", accelerators: ["Up", "Down"], keys: ["↑↓"] },
  "palette-accept": { owner: "palette", accelerators: ["Enter"], keys: ["↵"], mac: { keys: ["↩"] } },
  "palette-dismiss": { owner: "palette", accelerators: ["Escape"], keys: ["esc"] },
} as const satisfies Partial<Record<StaticCommandId | OwnedShortcutId, ShortcutDefinition>>;

export type ShortcutId = keyof typeof SHORTCUTS;
export type ShellShortcutId = {
  [Id in ShortcutId]: typeof SHORTCUTS[Id]["owner"] extends "shell" | "history-restore" ? Id : never
}[ShortcutId];

function shortcutOn(id: ShortcutId, platform: string | undefined): ShortcutKeys {
  const row: ShortcutDefinition = SHORTCUTS[id];
  return platform === "darwin" && row.mac ? { ...row, ...row.mac } : row;
}

// Every chord the row answers, its layout aliases last.
export function shortcutAccelerators(id: StaticCommandId | OwnedShortcutId, platform: string | undefined): readonly string[] {
  if (!Object.hasOwn(SHORTCUTS, id)) return [];
  const row: ShortcutDefinition = SHORTCUTS[id as ShortcutId];
  const accelerators = shortcutOn(id as ShortcutId, platform).accelerators;
  return row.layoutAliases ? [...accelerators, ...row.layoutAliases] : accelerators;
}

// macOS shows modifiers as symbols, in the order Control, Option, Shift, Command.
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "CommandOrControl"];
const ANY_KEYS: Readonly<Record<string, string>> = { Up: "↑", Down: "↓", Plus: "+", numadd: "Num +", numsub: "Num -" };
const MAC_KEYS: Readonly<Record<string, string>> = {
  ...ANY_KEYS, Ctrl: "⌃", Alt: "⌥", Shift: "⇧", CommandOrControl: "⌘", Enter: "↩", Escape: "esc", Backspace: "⌫", Delete: "⌦",
};
const OTHER_KEYS: Readonly<Record<string, string>> = {
  ...ANY_KEYS, CommandOrControl: "Ctrl", Escape: "Esc", PageUp: "Page Up", PageDown: "Page Down",
};

function acceleratorKeys(accelerator: string, platform: string | undefined): readonly string[] {
  const keys = accelerator.split("+");
  if (platform !== "darwin") return keys.map((key) => OTHER_KEYS[key] ?? key);
  const rank = (key: string) => MAC_ORDER.includes(key) ? MAC_ORDER.indexOf(key) : MAC_ORDER.length;
  return [...keys].sort((a, b) => rank(a) - rank(b)).map((key) => MAC_KEYS[key] ?? key);
}

export function shortcutKeys(id: ShortcutId, platform: string | undefined): readonly string[] {
  const row = shortcutOn(id, platform);
  return row.keys ?? acceleratorKeys(row.accelerators[0]!, platform);
}

// The keys of each chord a person presses for the row, one list per chord.
export function shortcutChords(id: ShortcutId, platform: string | undefined): readonly (readonly string[])[] {
  return shortcutOn(id, platform).accelerators.map((accelerator) => acceleratorKeys(accelerator, platform));
}

// A key chip: ⌘P on macOS, Ctrl P elsewhere.
export function shortcutText(id: ShortcutId, platform: string | undefined): string {
  return shortcutKeys(id, platform).join(platform === "darwin" ? "" : " ");
}

// A chord inside a tooltip: ⌘P on macOS, Ctrl+P elsewhere.
export function shortcutTitle(id: ShortcutId, platform: string | undefined): string {
  return shortcutKeys(id, platform).join(platform === "darwin" ? "" : "+");
}

// The platform's command modifier, held alone: Command on macOS and Control
// elsewhere. macOS keeps Control chords for text editing, such as ⌃A and ⌃K.
export function hasPrimaryModifier(event: { metaKey: boolean; ctrlKey: boolean }, platform: string | undefined): boolean {
  return platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// Editor keymaps get the event first and own their chords.
export function matchShellShortcut(event: KeyboardEvent, platform: string | undefined): ShellShortcutId | null {
  if (event.repeat || event.isComposing) return null;
  return matchShellShortcutChord(event, platform);
}

// Modal guards also consume held and composing chords before native menu fallback.
export function matchShellShortcutChord(event: KeyboardEvent, platform: string | undefined): ShellShortcutId | null {
  // Every shell chord holds Control or Command, so typing returns here.
  if ((!event.ctrlKey && !event.metaKey) || event.defaultPrevented) return null;
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    const owner = SHORTCUTS[id].owner;
    if ((owner === "shell" || owner === "history-restore") && matchesShortcut(event, id, platform)) {
      return id as ShellShortcutId;
    }
  }
  return null;
}

// Shift changes event.key, such as } for ⇧⌘], so these keys also match by
// their physical key.
const SHIFTED_KEY_CODES: Readonly<Record<string, string>> = { "[": "BracketLeft", "]": "BracketRight" };

// Whether the event is one of the row's chords. CommandOrControl is Command
// on macOS and Control elsewhere; Ctrl is Control on every platform.
export function matchesShortcut(event: ShortcutEvent, id: ShortcutId, platform: string | undefined): boolean {
  const row: ShortcutDefinition = SHORTCUTS[id];
  const mac = platform === "darwin";
  return shortcutAccelerators(id, platform).some((accelerator) => {
    const parts = accelerator.split("+");
    const primary = parts.includes("CommandOrControl");
    if (event.metaKey !== (mac && primary) || event.ctrlKey !== (parts.includes("Ctrl") || (!mac && primary))
      || event.shiftKey !== parts.includes("Shift") || event.altKey !== parts.includes("Alt")) return false;
    const key = parts.at(-1)!.toLowerCase();
    return event.key.toLowerCase() === key || event.code === SHIFTED_KEY_CODES[key]
      // macOS reports the Option character, such as ∫ for ⌥⌘B, in event.key.
      || (row.macOptionCode !== undefined && mac && event.code === row.macOptionCode);
  });
}
