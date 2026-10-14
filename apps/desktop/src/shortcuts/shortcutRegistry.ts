import type { StaticCommandId } from "../renderer/commands/commandRows";

// These ids already have owners outside the palette's command rows.
type EditorShortcutId = "editor-link" | "editor-bold" | "editor-undo" | "editor-redo" | "editor-find" | "editor-replace"
  | "editor-paragraph" | "editor-heading-1" | "editor-heading-2" | "editor-heading-3" | "editor-heading-4" | "editor-heading-5" | "editor-heading-6"
  | "editor-delete-word" | "editor-backspace-word" | "editor-hard-break" | "editor-select-all" | "editor-highlight" | "editor-blockquote" | "editor-bullet-list"
  | "editor-code" | "editor-code-block" | "editor-italic" | "editor-strike" | "editor-underline" | "editor-ordered-list" | "editor-task-list";
type OwnedShortcutId = "command-palette" | "close-window" | "history-restore-undo"
  | EditorShortcutId
  | "palette-move" | "palette-accept" | "palette-dismiss" | "dev-panel";
type ShortcutOwner = "shell" | "main" | "native" | "document" | "editor" | "palette" | "dev";
interface ShortcutDefinition {
  owner: ShortcutOwner;
  accelerators: readonly string[];
  macOptionCode?: string;
  // Preserve existing display spelling even where a hint used a fixed platform name.
  hint?: string;
  keys?: readonly string[];
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
  "history-restore-undo": { owner: "shell", accelerators: ["CommandOrControl+Z"] },
  "close-window": { owner: "native", accelerators: ["CommandOrControl+Shift+W"] },
  "zoom-reset": { owner: "main", accelerators: ["CommandOrControl+0"] },
  "zoom-in": { owner: "main", accelerators: ["CommandOrControl+=", "CommandOrControl+Plus", "CommandOrControl+numadd"] },
  "zoom-out": { owner: "main", accelerators: ["CommandOrControl+-", "CommandOrControl+numsub"] },
  "toggle-markdown-source": { owner: "document", accelerators: ["CommandOrControl+/"], hint: "Ctrl+/" },
  "editor-link": { owner: "editor", accelerators: ["CommandOrControl+K"], hint: "Cmd+K" },
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
  "editor-replace": { owner: "editor", accelerators: ["CommandOrControl+H"] },
  "palette-move": { owner: "palette", accelerators: ["Up", "Down"], keys: ["↑↓"] },
  "palette-accept": { owner: "palette", accelerators: ["Enter"], keys: ["↵"] },
  "palette-dismiss": { owner: "palette", accelerators: ["Escape"], keys: ["esc"] },
  "dev-panel": { owner: "dev", accelerators: ["CommandOrControl+Shift+D"], hint: "Ctrl Shift D" },
} as const satisfies Partial<Record<StaticCommandId | OwnedShortcutId, ShortcutDefinition>>;

export type ShortcutId = keyof typeof SHORTCUTS;
export type ShellShortcutId = {
  [Id in ShortcutId]: typeof SHORTCUTS[Id]["owner"] extends "shell" ? Id : never
}[ShortcutId];

export function shortcutAccelerators(id: StaticCommandId | OwnedShortcutId): readonly string[] {
  return Object.hasOwn(SHORTCUTS, id) ? SHORTCUTS[id as ShortcutId].accelerators : [];
}

export function shortcutKeys(id: ShortcutId, platform: string | undefined): readonly string[] {
  const row: ShortcutDefinition = SHORTCUTS[id];
  return row.keys ?? row.accelerators[0]!.split("+").map((key) =>
    key === "CommandOrControl" ? (platform === "darwin" ? "⌘" : "Ctrl") : key,
  );
}

export function shortcutText(id: ShortcutId, platform: string | undefined): string {
  const row: ShortcutDefinition = SHORTCUTS[id];
  if (row.hint) return row.hint;
  return shortcutKeys(id, platform).join(platform === "darwin" ? "" : " ");
}

// The shell accepts either modifier on every platform, as it did before the
// extraction. Editor keymaps still get the event first and own their chords.
export function matchShellShortcut(event: KeyboardEvent): ShellShortcutId | null {
  if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey)
    || event.defaultPrevented || event.repeat || event.isComposing) return null;
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    const row: ShortcutDefinition = SHORTCUTS[id];
    if (row.owner !== "shell") continue;
    for (const accelerator of row.accelerators) {
      const parts = accelerator.split("+");
      if (event.shiftKey !== parts.includes("Shift") || event.altKey !== parts.includes("Alt")) continue;
      const key = parts.at(-1)!.toLowerCase();
      if (event.key.toLowerCase() === key
        || (row.macOptionCode && event.metaKey && event.code === row.macOptionCode)) {
        return id as ShellShortcutId;
      }
    }
  }
  return null;
}
