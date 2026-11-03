import { X } from "lucide-react";
import { keyTitle } from "../../shortcuts/shortcutRegistry";

// The Explorer's count of selected rows, at the bottom of the panel, outside
// the list that scrolls. It shows at two or more rows. Its live region stays
// mounted at every count, so a screen reader hears the count when it arrives.
export function SelectionBar(props: { count: number; onClear: () => void }) {
  const shown = props.count >= 2;
  return (
    <div
      data-testid="explorer-selection-bar"
      data-shown={shown}
      className={shown ? "flex h-8 shrink-0 items-center gap-2 border-t border-line bg-panel px-3" : "contents"}
    >
      <span
        role="status"
        aria-live="polite"
        className={shown ? "min-w-0 flex-1 truncate text-[12px] font-medium tabular-nums text-ink" : "sr-only"}
      >
        {shown ? `${props.count} selected` : ""}
      </span>
      {shown ? (
        <button
          type="button"
          aria-label="Clear selection"
          title={`Clear selection (${keyTitle("Escape", window.dohcDesktop?.platform)})`}
          onClick={props.onClear}
          className="grid size-6 shrink-0 place-items-center rounded text-subtle hover:bg-hover hover:text-ink"
        >
          <X size={13} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
