import { useEffect, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { HeldNoteChangeResult } from "../ipc/bridgeContract";
import type { ReportButtonError } from "./collections/useAutomationButtons";
import { bridge } from "./bridge";
import { ConfirmDialog } from "./ui/ConfirmDialog";

export function waitingAuthors(authors: HeldNoteChangeResult["authors"]): string {
  const names: string[] = [];
  let unknown = authors.length === 0;
  for (const author of authors) {
    const name = author.name;
    if (name) names.push(name);
    else unknown = true;
  }
  const known = [...new Set(names)];
  if (known.length === 0) return "dohc does not know who made the waiting edits.";
  return `Waiting edits by ${known.join(", ")}.${unknown ? " Some edits have no known author." : ""}`;
}

export function HeldNoteDrop(props: {
  workspaceId: string;
  path: string;
  onError?: ReportButtonError;
  onNotice?: (message: string, undo?: () => void) => void;
}) {
  const scope = `${props.workspaceId}\0${props.path}`;
  const current = useRef(scope);
  current.current = scope;
  const [review, setReview] = useState<{scope: string; result: HeldNoteChangeResult} | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    current.current = scope;
    setBusy(false);
    return () => { current.current = ""; };
  }, [scope]);

  async function open() {
    setBusy(true);
    try {
      const result = await bridge().heldNoteChange({workspaceId: props.workspaceId, path: props.path, action: "review"});
      if (current.current === scope) setReview({scope, result});
    } catch (error) {
      if (current.current === scope) props.onError?.("dohc could not read the held change.", error, () => { void open(); });
    } finally { if (current.current === scope) setBusy(false); }
  }

  async function drop(token: string) {
    setReview(null);
    setBusy(true);
    try {
      const result = await bridge().heldNoteChange({workspaceId: props.workspaceId, path: props.path, action: "drop", token});
      // The held band can disappear before this reply. The shell owns these
      // reporters and keeps the toast and Undo scoped to their workspace.
      const undo = () => {
        void bridge().heldNoteChange({workspaceId: props.workspaceId, path: props.path, action: "undo", token: result.token})
          .then(() => props.onNotice?.("Restored the held change"))
          .catch(error => props.onError?.("dohc could not undo Drop.", error, undo));
      };
      props.onNotice?.("Dropped the held change", undo);
    } catch (error) {
      props.onError?.("dohc could not drop the held change. Review it again.", error, () => { void open(); });
    } finally { if (current.current === scope) setBusy(false); }
  }

  return <>
    <button type="button" disabled={busy} className="whitespace-nowrap text-muted hover:text-ink disabled:opacity-50"
      data-testid="held-note-drop" onClick={() => { void open(); }}>Drop</button>
    {review?.scope === scope ? <ConfirmDialog icon={Trash2} intent="danger" title="Drop the held change?"
      confirmLabel="Drop" testId="held-note-drop-dialog" cancelTestId="held-note-drop-cancel" confirmTestId="held-note-drop-confirm"
      onCancel={() => setReview(null)} onConfirm={() => { void drop(review.result.token); }}>
      <p className="max-h-40 overflow-y-auto break-words">{waitingAuthors(review.result.authors)}</p>
      <p>The note returns to the file on disk. History keeps the waiting text, and Undo brings it back as held.</p>
    </ConfirmDialog> : null}
  </>;
}
