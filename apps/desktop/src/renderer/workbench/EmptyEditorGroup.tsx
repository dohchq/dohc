import { DohcMark } from "@dohc/brand";
import { shortcutText } from "../../shortcuts/shortcutRegistry";

// An editor group with no open tab offers its next actions with their keys.
export function EmptyEditorGroup(props: {
  platform: string | undefined;
  onNewFile: () => void;
  onOpenPalette: () => void;
  onOpenQuickOpen: () => void;
}) {
  const chips = [
    ["new-file", "new file", props.onNewFile],
    ["command-palette", "commands", props.onOpenPalette],
    ["quick-open", "go to", props.onOpenQuickOpen],
  ] as const;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <DohcMark size={30} className="text-line" />
      <span className="text-sm text-muted">
        Select a file, or create one
      </span>
      {/* A narrow group wraps whole chips onto more lines. */}
      <div className="flex max-w-full flex-wrap justify-center gap-2 px-4">
        {chips.map(([id, label, open]) => (
          <button
            key={id}
            type="button"
            onClick={open}
            className="whitespace-nowrap rounded-md border border-line px-2.5 py-1 font-mono text-[11px] text-subtle transition-colors hover:bg-hover hover:text-ink"
          >
            {`${shortcutText(id, props.platform)} · ${label}`}
          </button>
        ))}
      </div>
    </div>
  );
}
