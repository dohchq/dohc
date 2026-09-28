import { X } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { AskAgentButton, type AgentRequest, type CollectionFile } from "../askAgent";
import { Overlay } from "../Overlay";
import { AUTOMATIONS_FILE } from "./AutomationsPanel";
import { CustomizeContext } from "../settings/customize";
import { IconButton } from "../ui/controls";

/**
 * A Collection's Customize…: the files that hold its setup, and the way to
 * hand a change to the person's agent. Fields and ⚡ in the header edit the
 * same files.
 */
export function CollectionCustomizeDialog(props: {
  name: string;
  files: readonly CollectionFile[];
  onClose: () => void;
}) {
  const shellAgent = useContext(CustomizeContext)?.askAgent;
  // Asking opens the agent's chat, and setting up opens Settings: either
  // way this dialog is done.
  const askAgent = shellAgent && {
    ready: shellAgent.ready,
    ask: (request: AgentRequest) => {
      props.onClose();
      shellAgent.ask(request);
    },
    setUp: () => {
      props.onClose();
      shellAgent.setUp();
    },
  };
  // What opened this dialog, read before Close takes focus. Dismissing it
  // returns focus there; a menu item inside a closed <details> hands it to
  // that menu's summary. Asking or setting up moves on, so focus goes with it.
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
          <h2 id="collection-customize-title" className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {`Customize ${props.name}`}
          </h2>
          <IconButton ref={closeRef} aria-label="Close" title="Close" onClick={dismiss}>
            <X size={14} aria-hidden />
          </IconButton>
        </div>
        <dl className="m-0 mt-4 flex flex-col gap-2">
          {props.files.map((file) => (
            <div key={file.path} className="grid grid-cols-[8rem_minmax(0,1fr)] items-center gap-3">
              <dt className="text-[12px] text-muted">{file.holds.slice(0, 1).toUpperCase() + file.holds.slice(1)}</dt>
              <dd className="m-0 min-w-0">
                <code title={file.path} className="block select-text truncate rounded-md bg-panel-2 px-2 py-1 font-mono text-[11px] text-ink">
                  {file.path}
                </code>
              </dd>
            </div>
          ))}
        </dl>
        {askAgent ? (
          <div className="mt-4">
            <AskAgentButton askAgent={askAgent} request={{ kind: "collection", name: props.name, files: props.files }} />
          </div>
        ) : null}
      </div>
    </Overlay>
  );
}

/** The files a document Collection keeps in its folder. */
export function documentCollectionFiles(folder: string): CollectionFile[] {
  return [
    { path: `${folder}/collection.yaml`, holds: "fields and views" },
    { path: `${folder}/${AUTOMATIONS_FILE}`, holds: "automations" },
  ];
}
