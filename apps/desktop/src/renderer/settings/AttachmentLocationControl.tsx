import { useId } from "react";
import type { WorkspaceSettings } from "../../workspaces/workspaceSettings";
import { computeAttachmentPaths } from "../editor/imagePaste";
import { useRadioGroup } from "../ui/SegmentedControl";

type AttachmentLocation = WorkspaceSettings["files"]["attachmentLocation"];

const OPTIONS = [
  { value: "per-document", label: "In a folder beside the document" },
  { value: "global-folder", label: "In one folder for the whole workspace" },
  { value: "same-folder", label: "Beside the document" },
] as const satisfies ReadonlyArray<{ value: AttachmentLocation; label: string }>;

// The document each choice's example path is pasted into.
const EXAMPLE_DOCUMENT = "Trips/Lisbon/itinerary.md";
const EXAMPLE_FOLDER = "Trips/Lisbon/";

/**
 * Where a pasted image is saved, as one radio per choice. Each shows the path
 * the paste writes, from the same code that writes it.
 */
export function AttachmentLocationControl(props: {
  value: AttachmentLocation;
  folderName: string;
  onChange: (value: AttachmentLocation) => void;
}) {
  const id = useId();
  const group = useRadioGroup({ value: props.value, options: OPTIONS, onChange: props.onChange });
  return (
    <div
      role="radiogroup"
      aria-label="Attachment location"
      data-testid="attachment-location"
      onKeyDown={group.onKeyDown}
      className="-mx-2 flex flex-col gap-0.5"
    >
      {OPTIONS.map((option, index) => {
        const checked = props.value === option.value;
        const path = computeAttachmentPaths(EXAMPLE_DOCUMENT, "photo.png", {
          location: option.value,
          folderName: props.folderName,
        }).writePath;
        const folder = path.startsWith(EXAMPLE_FOLDER) ? EXAMPLE_FOLDER : "";
        return (
          <button
            key={option.value}
            {...group.radio(index)}
            data-testid={`attachment-location-${option.value}`}
            // Named by its choice; the example path describes it.
            aria-label={option.label}
            aria-describedby={`${id}-${option.value}`}
            className={`grid h-9 grid-cols-[14px_auto_minmax(0,1fr)] items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75 ${
              checked ? "bg-selected text-ink" : "text-muted hover:bg-hover hover:text-ink"
            }`}
          >
            <span
              aria-hidden
              className={`grid size-3.5 place-items-center rounded-full border-[1.5px] ${
                checked ? "border-accent" : "border-subtle"
              }`}
            >
              {checked ? <span className="size-1.5 rounded-full bg-accent" /> : null}
            </span>
            {option.label}
            <span
              id={`${id}-${option.value}`}
              title={path}
              className="truncate text-right font-mono text-[11px] text-muted"
            >
              {folder}
              <span className="text-ink">{path.slice(folder.length)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
