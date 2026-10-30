import { matchShellShortcut, shortcutText } from "../shortcuts/shortcutRegistry";
import { isComposingKey } from "./ui/keys";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { rendererMarks } from "../performance/rendererMarks";
import { Overlay } from "./Overlay";
import { MENU_ACTIVE_OPTION } from "./ui/Menu";

export interface Command {
  id: string;
  label: string;
  run: () => void;
}

export const MAX_COMMAND_PALETTE_MATCHES = 50;

export function CommandPalette(props: {
  commands: Command[];
  onClose: () => void;
  testId?: string;
  placeholder?: string;
  ariaLabel?: string;
  toggleShortcut?: "command-palette" | "quick-open";
  // Optional ranking seam: Quick Open passes its prepared path
  // ranker. Default palettes keep the simple substring filter.
  rank?: (query: string, commands: Command[]) => Command[];
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cap rendered rows: a workspace can have thousands of files (quick-open),
  // and rendering them all per keystroke is wasted work.
  const filterStart = performance.now();
  const needle = query.toLowerCase();
  const matches = (
    props.rank
      ? props.rank(query, props.commands)
      : props.commands.filter((command) => command.label.toLowerCase().includes(needle))
  ).slice(0, MAX_COMMAND_PALETTE_MATCHES);
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
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function runCommand(command: Command | undefined) {
    if (!command) return;
    props.onClose();
    command.run();
  }

  return (
    <Overlay
      onClose={props.onClose}
      closeOnBackdrop
      panelProps={{
        onKeyDown: (event) => {
          if (matchShellShortcut(event.nativeEvent, window.dohcDesktop?.platform) === (props.toggleShortcut ?? "command-palette")) {
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
        <div className="flex items-center gap-2.5 border-b border-line px-4 transition-colors focus-within:border-ink">
          <Search size={14} aria-hidden className="shrink-0 text-subtle" />
          <input
            spellCheck={false}
            ref={inputRef}
            type="text"
            aria-label={props.ariaLabel ?? "Command"}
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
        </div>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Commands"
          className="m-0 max-h-72 list-none overflow-y-auto p-1"
        >
          {matches.length === 0 ? (
            <li className="px-3 py-2.5 text-xs text-subtle">No matching commands</li>
          ) : (
            matches.map((command, index) => (
              <li key={command.id} role="option" aria-selected={index === selected}>
                <button
                  type="button"
                  data-active={index === selected || undefined}
                  // A result Tab reaches becomes the selected one, so its fill
                  // shows focus without a halo, as the arrows' does.
                  onFocus={() => setSelectedIndex(index)}
                  onClick={() => runCommand(command)}
                  className={`flex h-8 w-full items-center rounded-md px-2 text-left text-[13px] transition-colors duration-75 focus-visible:outline-none ${MENU_ACTIVE_OPTION} ${
                    // Keyboard selection stays stronger than hover.
                    index === selected ? "text-ink" : "text-muted hover:bg-hover hover:text-ink"
                  }`}
                >
                  {command.label}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-3.5 py-2 text-[10px] text-subtle">
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans">{shortcutText("palette-move", window.dohcDesktop?.platform)}</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans">{shortcutText("palette-accept", window.dohcDesktop?.platform)}</kbd>
            open
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-line bg-bg px-1 font-sans">{shortcutText("palette-dismiss", window.dohcDesktop?.platform)}</kbd>
            dismiss
          </span>
        </div>
      </div>
    </Overlay>
  );
}
