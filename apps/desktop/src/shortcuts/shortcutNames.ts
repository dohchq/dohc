import { COMMAND_ROWS, isStaticCommandId, type StaticCommandId } from "../renderer/commands/commandRows";
import { SHORTCUTS, type ShortcutId } from "./shortcutRegistry";

// A shortcut that runs a command row takes the row's label; these name the
// rest. Shortcuts under one heading in Settings > Keyboard that share a name
// show as one row with all their keys, such as Find next's Enter and F3.
const NAMES = {
  "command-palette": "Command palette",
  "close-window": "Close window",
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
  "find-next": "Find next",
  "find-previous": "Find previous",
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

// Every name, once, for Settings search.
export const SHORTCUT_NAMES: readonly string[] = [...new Set((Object.keys(SHORTCUTS) as ShortcutId[]).map(shortcutName))];
