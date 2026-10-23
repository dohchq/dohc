import { COMMAND_ROWS, isStaticCommandId, type StaticCommandId } from "../renderer/commands/commandRows";
import { SHORTCUTS, type ShortcutId, type ShortcutOwner } from "./shortcutRegistry";

// A shortcut that runs a command row takes the row's label; these name the
// rest. Shortcuts under one heading in Settings > Keyboard that share a name
// show as one row with all their keys, such as Delete backward's ⌘⌫ and ⌃H
// on macOS, so they share an owner too: it decides where the keys work.
const NAMES = {
  "command-palette": "Command palette",
  "close-window": "Close window",
  "quit": "Quit",
  "history-restore-undo": "Undo restore",
  "dev-panel": "Dev tools",
  "editor-undo": "Undo",
  "editor-redo": "Redo",
  "editor-select-all": "Select all",
  "editor-bold": "Bold",
  "editor-italic": "Italic",
  "editor-underline": "Underline",
  "editor-strike": "Strikethrough",
  "editor-code": "Code",
  "editor-highlight": "Highlight",
  "editor-link": "Link",
  "editor-paragraph": "Text",
  "editor-heading-1": "Heading 1",
  "editor-heading-2": "Heading 2",
  "editor-heading-3": "Heading 3",
  "editor-heading-4": "Heading 4",
  "editor-heading-5": "Heading 5",
  "editor-heading-6": "Heading 6",
  "editor-bullet-list": "Bulleted list",
  "editor-ordered-list": "Numbered list",
  "editor-task-list": "Todo list",
  "editor-blockquote": "Quote",
  "editor-code-block": "Code block",
  "editor-hard-break": "Line break",
  "editor-backspace-word": "Delete backward",
  "editor-mac-backspace": "Delete backward",
  "editor-delete-word": "Delete forward",
  "editor-mac-delete": "Delete forward",
  "editor-mac-line-start": "Move to paragraph start",
  "editor-mac-line-end": "Move to paragraph end",
  "editor-find": "Find",
  "editor-replace": "Find and replace",
  "find-next": "Next match",
  "find-previous": "Previous match",
  "find-again-next": "Find next",
  "find-again-previous": "Find previous",
  "find-close": "Close find",
  "palette-move": "Navigate",
  "palette-accept": "Open",
  "palette-dismiss": "Dismiss",
} as const satisfies Record<Exclude<ShortcutId, StaticCommandId>, string>;

export function shortcutName(id: ShortcutId): string {
  return isStaticCommandId(id) ? COMMAND_ROWS[id].label : NAMES[id];
}

// Whether Settings > Keyboard lists the shortcut: only on its platforms, and
// Dev tools' key only where the dev tools show.
export function shortcutShown(id: ShortcutId, platform: string | undefined, devTools: boolean): boolean {
  const shortcut: { owner: ShortcutOwner; platforms?: readonly string[] } = SHORTCUTS[id];
  return (!shortcut.platforms || shortcut.platforms.includes(platform ?? "")) && (shortcut.owner !== "dev" || devTools);
}

// The names Settings > Keyboard lists, once each, for Settings search.
export function shownShortcutNames(platform: string | undefined, devTools: boolean): string[] {
  const ids = (Object.keys(SHORTCUTS) as ShortcutId[]).filter((id) => shortcutShown(id, platform, devTools));
  return [...new Set(ids.map(shortcutName))];
}
