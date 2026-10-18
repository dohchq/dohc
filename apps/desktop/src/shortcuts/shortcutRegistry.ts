import type { StaticCommandId } from "../renderer/commands/commandRows";

// These ids already have owners outside the palette's command rows.
type EditorShortcutId = "editor-mac-backspace" | "editor-mac-delete" | "editor-mac-line-start" | "editor-mac-line-end" | "editor-link" | "editor-bold" | "editor-undo" | "editor-redo" | "editor-find" | "editor-replace"
  | "editor-paragraph" | "editor-heading-1" | "editor-heading-2" | "editor-heading-3" | "editor-heading-4" | "editor-heading-5" | "editor-heading-6"
  | "editor-delete-word" | "editor-backspace-word" | "editor-hard-break" | "editor-select-all" | "editor-highlight" | "editor-blockquote" | "editor-bullet-list"
  | "editor-code" | "editor-code-block" | "editor-italic" | "editor-strike" | "editor-underline" | "editor-ordered-list" | "editor-task-list";
type OwnedShortcutId = "command-palette" | "close-window" | "history-restore-undo"
  | EditorShortcutId
  | "palette-move" | "palette-accept" | "palette-dismiss" | "find-next" | "find-previous" | "find-close" | "dev-panel";
type ShortcutOwner = "history-restore" | "shell" | "main" | "native" | "document" | "editor" | "palette" | "find" | "dev";
interface ShortcutKeys {
  accelerators: readonly string[];
  // Shown instead of the text derived from the first accelerator.
  keys?: readonly string[];
}
interface ShortcutDefinition extends ShortcutKeys {
  owner: ShortcutOwner;
  // Replaces the row's keys on macOS, where its convention differs.
  mac?: Partial<ShortcutKeys>;
  macOptionCode?: string;
  // The row exists only on this platform.
  platform?: "darwin";
}

export const SHORTCUTS = {
  "new-file": { owner: "shell", accelerators: ["CommandOrControl+N"] },
  "command-palette": { owner: "shell", accelerators: ["CommandOrControl+Shift+P", "CommandOrControl+K"] },
  "quick-open": { owner: "shell", accelerators: ["CommandOrControl+P"] },
  "toggle-sidebar": { owner: "shell", accelerators: ["CommandOrControl+B"] },
  "toggle-about": { owner: "shell", accelerators: ["CommandOrControl+Alt+B"], macOptionCode: "KeyB" },
  "close-tab": { owner: "shell", accelerators: ["CommandOrControl+W"] },
  "new-editor-group-right": { owner: "shell", accelerators: ["CommandOrControl+\\"] },
  "settings": { owner: "shell", accelerators: ["CommandOrControl+,"] },
  "history-restore-undo": { owner: "history-restore", accelerators: ["CommandOrControl+Z"] },
  "close-window": { owner: "native", accelerators: ["CommandOrControl+Shift+W"] },
  "zoom-reset": { owner: "main", accelerators: ["CommandOrControl+0"] },
  "zoom-in": { owner: "main", accelerators: ["CommandOrControl+=", "CommandOrControl+Plus", "CommandOrControl+numadd"] },
  "zoom-out": { owner: "main", accelerators: ["CommandOrControl+-", "CommandOrControl+numsub"] },
  "toggle-markdown-source": { owner: "document", accelerators: ["CommandOrControl+/"] },
  "editor-mac-backspace": { owner: "editor", platform: "darwin", accelerators: ["Ctrl+H", "Alt+Backspace"] },
  "editor-mac-delete": { owner: "editor", platform: "darwin", accelerators: ["Ctrl+D", "Ctrl+Alt+Backspace", "Alt+Delete", "Alt+D"] },
  "editor-mac-line-start": { owner: "editor", platform: "darwin", accelerators: ["Ctrl+A"] },
  "editor-mac-line-end": { owner: "editor", platform: "darwin", accelerators: ["Ctrl+E"] },
  "editor-link": { owner: "editor", accelerators: ["CommandOrControl+K"] },
  "editor-bold": { owner: "editor", accelerators: ["CommandOrControl+B"] },
  "editor-undo": { owner: "editor", accelerators: ["CommandOrControl+Z", "CommandOrControl+Я"] },
  "editor-redo": { owner: "editor", accelerators: ["CommandOrControl+Shift+Z", "CommandOrControl+Y", "CommandOrControl+Shift+Я"] },
  "editor-paragraph": { owner: "editor", accelerators: ["CommandOrControl+Alt+0"] },
  "editor-heading-1": { owner: "editor", accelerators: ["CommandOrControl+Alt+1"] },
  "editor-heading-2": { owner: "editor", accelerators: ["CommandOrControl+Alt+2"] },
  "editor-heading-3": { owner: "editor", accelerators: ["CommandOrControl+Alt+3"] },
  "editor-heading-4": { owner: "editor", accelerators: ["CommandOrControl+Alt+4"] },
  "editor-heading-5": { owner: "editor", accelerators: ["CommandOrControl+Alt+5"] },
  "editor-heading-6": { owner: "editor", accelerators: ["CommandOrControl+Alt+6"] },
  "editor-delete-word": { owner: "editor", accelerators: ["CommandOrControl+Delete"] },
  "editor-backspace-word": { owner: "editor", accelerators: ["CommandOrControl+Backspace"] },
  "editor-hard-break": { owner: "editor", accelerators: ["CommandOrControl+Enter"] },
  "editor-select-all": { owner: "editor", accelerators: ["CommandOrControl+A"] },
  "editor-highlight": { owner: "editor", accelerators: ["CommandOrControl+Shift+H"] },
  "editor-blockquote": { owner: "editor", accelerators: ["CommandOrControl+Shift+B"] },
  "editor-bullet-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+8"] },
  "editor-code": { owner: "editor", accelerators: ["CommandOrControl+E"] },
  "editor-code-block": { owner: "editor", accelerators: ["CommandOrControl+Alt+C"] },
  "editor-italic": { owner: "editor", accelerators: ["CommandOrControl+I"] },
  "editor-strike": { owner: "editor", accelerators: ["CommandOrControl+Shift+S"] },
  "editor-underline": { owner: "editor", accelerators: ["CommandOrControl+U"] },
  "editor-ordered-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+7"] },
  "editor-task-list": { owner: "editor", accelerators: ["CommandOrControl+Shift+9"] },
  "editor-find": { owner: "editor", accelerators: ["CommandOrControl+F"] },
  // macOS keeps ⌘H for Hide, so Replace takes ⌥⌘F there, as in Xcode and Pages.
  "editor-replace": { owner: "editor", accelerators: ["CommandOrControl+H"], mac: { accelerators: ["CommandOrControl+Alt+F"] } },
  "palette-move": { owner: "palette", accelerators: ["Up", "Down"], keys: ["↑↓"] },
  "palette-accept": { owner: "palette", accelerators: ["Enter"], keys: ["↵"], mac: { keys: ["↩"] } },
  "palette-dismiss": { owner: "palette", accelerators: ["Escape"], keys: ["esc"] },
  "find-next": { owner: "find", accelerators: ["Enter"] },
  "find-previous": { owner: "find", accelerators: ["Shift+Enter"] },
  "find-close": { owner: "find", accelerators: ["Escape"] },
  "dev-panel": { owner: "dev", accelerators: ["CommandOrControl+Shift+D"] },
} as const satisfies Partial<Record<StaticCommandId | OwnedShortcutId, ShortcutDefinition>>;

export type ShortcutId = keyof typeof SHORTCUTS;
export type ShellShortcutId = {
  [Id in ShortcutId]: typeof SHORTCUTS[Id]["owner"] extends "shell" | "history-restore" ? Id : never
}[ShortcutId];

function shortcutOn(id: ShortcutId, platform: string | undefined): ShortcutKeys {
  const row: ShortcutDefinition = SHORTCUTS[id];
  return platform === "darwin" && row.mac ? { ...row, ...row.mac } : row;
}

export function shortcutAccelerators(id: StaticCommandId | OwnedShortcutId, platform: string | undefined): readonly string[] {
  return Object.hasOwn(SHORTCUTS, id) ? shortcutOn(id as ShortcutId, platform).accelerators : [];
}

// macOS shows modifiers as symbols, in the order Control, Option, Shift, Command.
const MAC_ORDER = ["Ctrl", "Alt", "Shift", "CommandOrControl"];
const MAC_KEYS: Readonly<Record<string, string>> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", CommandOrControl: "⌘", Enter: "↩", Escape: "esc" };
const OTHER_KEYS: Readonly<Record<string, string>> = { CommandOrControl: "Ctrl", Escape: "Esc" };

export function shortcutKeys(id: ShortcutId, platform: string | undefined): readonly string[] {
  const row = shortcutOn(id, platform);
  if (row.keys) return row.keys;
  const keys = row.accelerators[0]!.split("+");
  if (platform !== "darwin") return keys.map((key) => OTHER_KEYS[key] ?? key);
  const rank = (key: string) => MAC_ORDER.includes(key) ? MAC_ORDER.indexOf(key) : MAC_ORDER.length;
  return [...keys].sort((a, b) => rank(a) - rank(b)).map((key) => MAC_KEYS[key] ?? key);
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
  if (!hasPrimaryModifier(event, platform) || event.defaultPrevented) return null;
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    const row: ShortcutDefinition = SHORTCUTS[id];
    if (row.owner !== "shell" && row.owner !== "history-restore") continue;
    for (const accelerator of shortcutOn(id, platform).accelerators) {
      const parts = accelerator.split("+");
      if (event.shiftKey !== parts.includes("Shift") || event.altKey !== parts.includes("Alt")) continue;
      const key = parts.at(-1)!.toLowerCase();
      // macOS reports the Option character, such as ∫ for ⌥⌘B, in event.key.
      if (event.key.toLowerCase() === key
        || (row.macOptionCode && platform === "darwin" && event.code === row.macOptionCode)) {
        return id as ShellShortcutId;
      }
    }
  }
  return null;
}
