import {useEffect, useRef} from "react";

export function DiscardDraft({cancel, confirm}: {cancel(): void; confirm(): void}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {dialog.current?.showModal(); return () => dialog.current?.close();}, []);
  return <dialog ref={dialog} className="download-card" aria-label="Discard this draft?" onCancel={cancel}>
    <h2>Discard this draft?</h2><p>Unsynced changes exist only in this tab. Continuing discards them.</p>
    <p>Copy any changes you want to keep before continuing.</p>
    <button autoFocus className="handoff-button secondary" onClick={cancel}>Keep reviewing</button>
    <button className="handoff-button primary" onClick={confirm}>Discard draft and continue</button>
  </dialog>;
}
