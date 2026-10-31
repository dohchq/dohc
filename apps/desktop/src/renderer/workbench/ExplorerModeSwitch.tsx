import { useRef, type KeyboardEvent } from "react";
import { EXPLORER_MODES, type ExplorerMode } from "./workbenchState";

// The panel id the Explorer's view carries, which the switch controls.
export const EXPLORER_PANEL_ID = "explorer-panel";

const LABELS: Record<ExplorerMode, string> = { home: "Home", files: "Files" };

// Home | Files, in the side panel's header where the Explorer's title was.
// Left and Right move between the two and show the one they land on.
export function ExplorerModeSwitch(props: { mode: ExplorerMode; onChange: (mode: ExplorerMode) => void }) {
  const tabs = useRef(new Map<ExplorerMode, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = EXPLORER_MODES.indexOf(props.mode);
    const next = EXPLORER_MODES[(index + (event.key === "ArrowRight" ? 1 : EXPLORER_MODES.length - 1)) % EXPLORER_MODES.length]!;
    props.onChange(next);
    tabs.current.get(next)?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label="Explorer"
      data-testid="explorer-mode"
      onKeyDown={onKeyDown}
      className="flex rounded-lg border border-line bg-panel-2 p-0.5"
    >
      {EXPLORER_MODES.map((mode) => {
        const selected = mode === props.mode;
        return (
          <button
            key={mode}
            ref={(element) => {
              if (element) tabs.current.set(mode, element);
              else tabs.current.delete(mode);
            }}
            type="button"
            role="tab"
            data-testid={`explorer-mode-${mode}`}
            aria-selected={selected}
            aria-controls={selected ? EXPLORER_PANEL_ID : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => props.onChange(mode)}
            className={`rounded-md px-2.5 py-0.5 text-xs transition-colors ${
              selected ? "bg-bg text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {LABELS[mode]}
          </button>
        );
      })}
    </div>
  );
}
