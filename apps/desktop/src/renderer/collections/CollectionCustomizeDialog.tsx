import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Overlay } from "../Overlay";
import { AUTOMATIONS_FILE } from "./AutomationsPanel";
import { CopyField } from "../ui/CopyButton";
import { IconButton, SecondaryButton } from "../ui/controls";

/** One of a Collection's own files, and what it holds. */
export interface CollectionFile {
  path: string;
  holds: string;
  // Set while the file does not exist: what makes it, said in Open's place.
  missing?: string;
}

/**
 * A Collection's Customize…: the files that hold its setup, each with its
 * path to copy and Open. Fields and ⚡ in the header edit the same files.
 */
export function CollectionCustomizeDialog(props: {
  name: string;
  files: readonly CollectionFile[];
  onOpenFile: (path: string) => void;
  onClose: () => void;
}) {
  // What opened this dialog, read before Close takes focus. Dismissing it
  // returns focus there; a menu item inside a closed <details> hands it to
  // that menu's summary. Open moves on to the file's tab, so focus goes with it.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const dismiss = () => {
    props.onClose();
    const summary = opener?.closest("details:not([open])")?.querySelector("summary");
    (summary ?? opener)?.focus();
  };
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <Overlay onClose={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collection-customize-title"
        data-testid="collection-customize"
        className="dohc-elevated w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-bg p-5"
      >
        <div className="flex items-center gap-2">
          <h2 id="collection-customize-title" className="m-0 min-w-0 flex-1 truncate text-base font-semibold text-ink">
            {`Customize ${props.name}`}
          </h2>
          <IconButton ref={closeRef} aria-label="Close" title="Close" onClick={dismiss}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        <dl className="m-0 mt-4 flex flex-col gap-3">
          {props.files.map((file) => {
            const name = file.path.split("/").at(-1) ?? file.path;
            return (
              <div key={file.path} className="flex flex-col gap-1">
                <dt className="text-[12px] text-muted">{file.holds.slice(0, 1).toUpperCase() + file.holds.slice(1)}</dt>
                <dd className="m-0 flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <CopyField label={`Copy ${name} path`} copiedLabel="Path copied" getText={() => file.path}>
                      <code title={file.path}>{file.path}</code>
                    </CopyField>
                  </div>
                  {file.missing ? (
                    <span className="shrink-0 text-[12px] text-muted">{file.missing}</span>
                  ) : (
                    <SecondaryButton
                      size="compact"
                      aria-label={`Open ${name}`}
                      className="shrink-0"
                      onClick={() => {
                        props.onClose();
                        props.onOpenFile(file.path);
                      }}
                    >
                      Open
                    </SecondaryButton>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </Overlay>
  );
}

/** A Collection's automations file, which its first automation makes. */
export function automationsFile(folder: string, made: boolean): CollectionFile {
  const file = { path: `${folder}/${AUTOMATIONS_FILE}`, holds: "automations" };
  return made ? file : { ...file, missing: "Made with the first automation." };
}

/** The files a document Collection keeps in its folder. */
export function documentCollectionFiles(folder: string, automationsMade: boolean): CollectionFile[] {
  return [{ path: `${folder}/collection.yaml`, holds: "fields and views" }, automationsFile(folder, automationsMade)];
}
