import { useEffect, useRef } from "react";

type Words = { title: string; body: readonly string[]; keep: string; discard: string };
const DRAFT: Words = {
  title: "Discard this draft?",
  body: [
    "Unsynced changes exist only in this tab. Continuing discards them.",
    "Copy any changes you want to keep before continuing.",
  ],
  keep: "Keep reviewing",
  discard: "Discard draft and continue",
};
/** A member's page calls the same text its unsent edits, as its kept rows do. */
export const UNSENT_EDITS: Words = {
  title: "Discard your unsent edits?",
  body: ["Only this tab has them. Copy or download them first to keep them."],
  keep: "Keep them",
  discard: "Discard",
};

export function DiscardDraft({
  cancel,
  confirm,
  words = DRAFT,
}: {
  cancel(): void;
  confirm(): void;
  words?: Words;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog ref={dialog} className="download-card" aria-label={words.title} onCancel={cancel}>
      <h2>{words.title}</h2>
      {words.body.map((line) => (
        <p key={line}>{line}</p>
      ))}
      <button autoFocus className="handoff-button secondary" onClick={cancel}>
        {words.keep}
      </button>
      <button className="handoff-button primary" onClick={confirm}>
        {words.discard}
      </button>
    </dialog>
  );
}
