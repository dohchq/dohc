import { matchShellShortcut, shortcutText } from "../shortcuts/shortcutRegistry";
import { isComposingKey } from "./ui/keys";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Cloud,
  Code2,
  Columns2,
  Download,
  FilePlus2,
  Files,
  FolderOpen,
  FolderPlus,
  Gift,
  History,
  Layers,
  MessageCircle,
  Palette,
  PanelLeft,
  PanelRight,
  PenTool,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Share2,
  Sparkles,
  SunMoon,
  Table2,
  Upload,
  Workflow,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { rendererMarks } from "../performance/rendererMarks";
import type { CommandIconId } from "./commands/commandRows";
import { Overlay } from "./Overlay";
import { MENU_ACTIVE_OPTION, movedPointer } from "./ui/Menu";

const COMMAND_ICONS: Record<CommandIconId, LucideIcon> = {
  "file-plus": FilePlus2,
  "pen-tool": PenTool,
  "folder-plus": FolderPlus,
  table: Table2,
  search: Search,
  "folder-open": FolderOpen,
  upload: Upload,
  download: Download,
  "panel-left": PanelLeft,
  x: X,
  "arrow-right": ArrowRight,
  "arrow-left": ArrowLeft,
  columns: Columns2,
  code: Code2,
  share: Share2,
  "panel-right": PanelRight,
  files: Files,
  "message-circle": MessageCircle,
  workflow: Workflow,
  history: History,
  layers: Layers,
  "app-window": AppWindow,
  cloud: Cloud,
  settings: Settings,
  palette: Palette,
  sparkles: Sparkles,
  refresh: RefreshCw,
  gift: Gift,
  "sun-moon": SunMoon,
  "zoom-in": ZoomIn,
  "zoom-out": ZoomOut,
  "rotate-ccw": RotateCcw,
};

export function renderCommandIcon(icon: CommandIconId): ReactNode {
  const Icon = COMMAND_ICONS[icon];
  return <Icon size={14} aria-hidden />;
}

export interface Command {
  id: string;
  label: string;
  run: () => void;
  icon?: ReactNode;
  subtitle?: string;
  badge?: ReactNode;
  group?: string;
  shortcut?: string;
  keywords?: readonly string[];
  ariaLabel?: string;
}

export const MAX_COMMAND_PALETTE_MATCHES = 50;

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const previous = text[index - 1] ?? "";
  return (
    previous === " " || previous === ":" || previous === "/" || previous === "-" || previous === "_"
  );
}

function subsequenceScore(text: string, needle: string): number {
  let score = 0;
  let cursor = 0;
  let consecutive = 0;
  for (let i = 0; i < needle.length; i += 1) {
    const found = text.indexOf(needle[i]!, cursor);
    if (found < 0) return -1;
    if (found === cursor) {
      consecutive += 1;
      score += 8 + consecutive * 2;
    } else {
      consecutive = 0;
      score += isWordBoundary(text, found) ? 10 : 2;
    }
    cursor = found + 1;
  }
  return score - Math.min(text.length, 40) * 0.05;
}

function scoreField(text: string, needle: string, base: number): number {
  const lower = text.toLowerCase();
  const at = lower.indexOf(needle);
  if (at === 0) return base + 120 - Math.min(lower.length, 40) * 0.05;
  if (at > 0 && isWordBoundary(lower, at)) return base + 90 - at * 0.1;
  if (at > 0) return base + 60 - at * 0.1;
  const sub = subsequenceScore(lower, needle);
  return sub >= 0 ? base * 0.4 + sub : -1;
}

function scoreCommand(command: Command, needle: string): number {
  let best = scoreField(command.label, needle, 200);
  if (command.group) {
    best = Math.max(best, scoreField(command.group, needle, 80));
  }
  if (command.keywords) {
    for (const keyword of command.keywords) {
      best = Math.max(best, scoreField(keyword, needle, 130));
    }
  }
  return best;
}

function rankCommands(query: string, commands: Command[]): Command[] {
  if (query === "") return commands;
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    const raw = query.toLowerCase();
    return commands.filter((command) => command.label.toLowerCase().includes(raw));
  }
  const scored: Array<{ command: Command; score: number; index: number }> = [];
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index]!;
    const score = scoreCommand(command, needle);
    if (score >= 0) scored.push({ command, score, index });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((entry) => entry.command);
}

function renderHighlightedLabel(label: string, query: string): ReactNode {
  const needle = query.trim().toLowerCase();
  if (!needle) return label;
  const lower = label.toLowerCase();
  const at = lower.indexOf(needle);
  if (at >= 0) {
    return (
      <>
        {label.slice(0, at)}
        <mark className="bg-transparent font-semibold text-ink">
          {label.slice(at, at + needle.length)}
        </mark>
        {label.slice(at + needle.length)}
      </>
    );
  }
  const indices: number[] = [];
  let cursor = 0;
  for (let i = 0; i < needle.length; i += 1) {
    const found = lower.indexOf(needle[i]!, cursor);
    if (found < 0) return label;
    indices.push(found);
    cursor = found + 1;
  }
  const matched = new Set(indices);
  const parts: ReactNode[] = [];
  let chunkStart = 0;
  for (let i = 0; i < label.length; i += 1) {
    const isHit = matched.has(i);
    const nextHit = i + 1 < label.length && matched.has(i + 1);
    if (isHit !== nextHit || i === label.length - 1) {
      const slice = label.slice(chunkStart, i + 1);
      parts.push(
        isHit ? (
          <mark key={chunkStart} className="bg-transparent font-semibold text-ink">
            {slice}
          </mark>
        ) : (
          <Fragment key={chunkStart}>{slice}</Fragment>
        ),
      );
      chunkStart = i + 1;
    }
  }
  return parts;
}

export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
  toggleShortcut?: "command-palette" | "quick-open";
  // Optional ranking seam: Quick Open passes its prepared path
  // ranker. Default palettes use word-prefix + ordered-subsequence scoring.
  rank?: (query: string, commands: Command[]) => Command[];
  emptyText?: (query: string) => string;
  acceptLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cap rendered rows: a workspace can have thousands of files (quick-open),
  // and rendering them all per keystroke is wasted work.
  const filterStart = performance.now();
  const matches = useMemo(
    () =>
      (props.rank ? props.rank(query, props.commands) : rankCommands(query, props.commands)).slice(
        0,
        MAX_COMMAND_PALETTE_MATCHES,
      ),
    [props.commands, props.rank, query],
  );
  const filterMs = useRef(0);
  filterMs.current = performance.now() - filterStart;

  // Performance measures: the pure filter cost (query operation) and
  // keystroke→committed-results latency (visible result). Recorded only for
  // a real query so opening the palette doesn't log an empty-filter number.
  useEffect(() => {
    if (query === "") return;
    rendererMarks.record("file-tree-search-query", filterMs.current);
    rendererMarks.measureSince("file-tree-search-visible", "file-tree-search-input");
  }, [query]);

  // The match list can shrink under the selection as the query narrows.
  const selected = Math.min(selectedIndex, Math.max(matches.length - 1, 0));

  function moveSelection(delta: number) {
    if (matches.length === 0) return;
    setSelectedIndex((selected + delta + matches.length) % matches.length);
  }

  // Keep the keyboard-selected row visible inside the scrolling list.
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  const showGroups = query === "";

  return (
    <Overlay
      onClose={props.onClose}
      panelProps={{
        onKeyDown: (event) => {
          if (
            matchShellShortcut(event.nativeEvent, window.dohcDesktop?.platform) ===
            (props.toggleShortcut ?? "command-palette")
          ) {
            event.preventDefault();
            props.onClose();
          }
        },
      }}
    >
      <div
        data-testid={props.testId ?? "command-palette"}
        className="dohc-popover w-135 max-w-[80vw] overflow-hidden rounded-xl border border-line bg-panel"
      >
        {/* Focus lives on the framing row (focus-within), not the input: an
            input ring would clip into the rounded popover's overflow-hidden. */}
        <div className="flex items-center gap-2 border-b border-line px-4 transition-colors focus-within:border-ink">
          <Search size={14} aria-hidden className="shrink-0 text-subtle" />
          <input
            data-framed-input=""
            spellCheck={false}
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={true}
            aria-label={props.ariaLabel ?? "Command"}
            aria-controls={listId}
            aria-activedescendant={matches.length > 0 ? optionId(selected) : undefined}
            aria-autocomplete="list"
            placeholder={props.placeholder ?? "Type a command…"}
            value={query}
            onChange={(event) => {
              rendererMarks.mark("file-tree-search-input");
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (isComposingKey(event)) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onClose();
              } else if (event.key === "Enter") {
                // Its keypress would press whatever the command focused.
                event.preventDefault();
                runCommand(matches[selected]);
              }
            }}
            // Intentional focus treatment (the input autofocuses on open): no
            // ring — the framing row and caret carry focus, and the global
            // ring's top/sides would clip into the rounded popover.
            className="w-full bg-transparent py-3.5 text-sm text-ink outline-none placeholder:text-subtle"
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              title="Clear search"
              onClick={() => {
                setQuery("");
                setSelectedIndex(0);
                inputRef.current?.focus();
              }}
              className="grid size-6 shrink-0 place-items-center rounded-md text-subtle transition-colors hover:bg-hover hover:text-ink"
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
        </div>
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="m-0 max-h-96 list-none overflow-y-auto p-1"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2.5 text-xs text-subtle">
              {props.emptyText?.(query) ??
                (query ? `No commands match "${query}".` : "No matching commands.")}
            </li>
          ) : (
            matches.map((command, index) => {
              const previousGroup = index > 0 ? matches[index - 1]?.group : undefined;
              const groupHeader =
                showGroups && command.group && command.group !== previousGroup
                  ? command.group
                  : null;
              const isRich =
                command.icon !== undefined ||
                command.subtitle !== undefined ||
                command.badge !== undefined ||
                command.shortcut !== undefined;
              return (
                <Fragment key={command.id}>
                  {groupHeader ? (
                    <li
                      role="presentation"
                      className={`dohc-section-label px-2 pb-1 ${index === 0 ? "pt-1" : "pt-2"}`}
                    >
                      {groupHeader}
                    </li>
                  ) : null}
                  <li
                    id={optionId(index)}
                    role="option"
                    aria-selected={index === selected}
                    aria-label={command.ariaLabel}
                  >
                    <button
                      type="button"
                      aria-label={command.ariaLabel}
                      data-active={index === selected || undefined}
                      // A result Tab reaches becomes the selected one, so its fill
                      // shows focus without a halo, as the arrows' does.
                      onFocus={() => setSelectedIndex(index)}
                      onMouseMove={(event) => {
                        if (movedPointer(event)) setSelectedIndex(index);
                      }}
                      onClick={() => runCommand(command)}
                      className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-75 focus-visible:outline-none ${MENU_ACTIVE_OPTION} ${
                        // Keyboard selection stays stronger than hover.
                        index === selected ? "text-ink" : "text-muted hover:bg-hover hover:text-ink"
                      }`}
                    >
                      {isRich ? (
                        <>
                          {command.icon !== undefined ? (
                            <span
                              aria-hidden
                              className="grid size-4 shrink-0 place-items-center text-subtle"
                            >
                              {typeof command.icon === "string" &&
                              Object.hasOwn(COMMAND_ICONS, command.icon)
                                ? renderCommandIcon(command.icon as CommandIconId)
                                : command.icon}
                            </span>
                          ) : null}
                          <span className="min-w-0 truncate">
                            {renderHighlightedLabel(command.label, query)}
                          </span>
                          {command.subtitle ? (
                            <span className="min-w-0 truncate text-[12px] text-subtle">
                              {command.subtitle}
                            </span>
                          ) : null}
                          {command.badge !== undefined || command.shortcut ? (
                            <span className="ml-auto flex shrink-0 items-center gap-2">
                              {command.badge !== undefined ? (
                                <span aria-hidden className="flex items-center text-subtle">
                                  {command.badge}
                                </span>
                              ) : null}
                              {command.shortcut ? (
                                <kbd
                                  aria-hidden="true"
                                  className="rounded border border-line bg-bg px-1 font-sans text-[12px] text-subtle"
                                >
                                  {command.shortcut}
                                </kbd>
                              ) : null}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        renderHighlightedLabel(command.label, query)
                      )}
                    </button>
                  </li>
                </Fragment>
              );
            })
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[12px] text-subtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans text-[12px]">
              {shortcutText("palette-move", window.dohcDesktop?.platform)}
            </kbd>
            Navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans text-[12px]">
              {shortcutText("palette-accept", window.dohcDesktop?.platform)}
            </kbd>
            {props.acceptLabel ?? "Run"}
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans text-[12px]">
              {shortcutText("palette-dismiss", window.dohcDesktop?.platform)}
            </kbd>
            Close
          </span>
        </div>
      </div>
    </Overlay>
  );
}
