import {useEffect, useRef, useState} from "react";
import {collectionWriteBody, COLLECTION_WRITES_PATH, parseCollectionWriteOutcome, type CollectionWriteOutcome} from "../../src/collectionWrites";
import {DiscardDraft} from "./DiscardDraft";

const SESSION_HEADER = "x-dohc-link-session";
// The largest of a Collection's own files: its automations.yaml.
const MAX_FILE_BYTES = 256 * 1024;

/** A Collection's collection.yaml or automations.yaml, as its schema and automations are named on disk. */
export function isCollectionOwnFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return path.includes("/") && (name === "collection.yaml" || name === "automations.yaml");
}

type Status =
  | {kind: "loading"} | {kind: "load-failed"} | {kind: "editing"} | {kind: "saving"} | {kind: "sent"}
  | {kind: "not-saved"; outcome: Exclude<CollectionWriteOutcome, {ok: true}>};

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Edits a Collection's own file through an Edit link. A save goes to the
 * owner's workspace history at once and reaches the owner's computer when it
 * next syncs, so the editor says only what the relay has taken.
 */
export function CollectionFileEditor({session, path, blobSha256, available, onClose}: {
  session: string; path: string; blobSha256: string; available: boolean; onClose(): void;
}) {
  const [status, setStatus] = useState<Status>({kind: "loading"});
  // The content the draft replaces, and the text it replaced, so a save
  // names its base and leaving can tell whether anything is unsaved.
  const [base, setBase] = useState({blobSha256, text: ""});
  const [draft, setDraft] = useState("");
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  // One submit id per text, so a save whose answer was lost is sent again as itself.
  const submission = useRef<{id: string; text: string; base: string} | null>(null);
  const request = useRef<AbortController | null>(null);
  const unsaved = status.kind !== "loading" && status.kind !== "load-failed" && draft !== base.text;

  const load = (hash: string) => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setStatus({kind: "loading"});
    void fetch(`/api/view/blob/${hash}`, {credentials: "same-origin", headers: {[SESSION_HEADER]: session}, signal: controller.signal})
      .then(async response => {
        if (!response.ok) throw new Error("refused");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("too large");
        return new TextDecoder("utf-8", {fatal: true}).decode(bytes);
      })
      .then(text => {
        if (controller.signal.aborted) return;
        submission.current = null; setBase({blobSha256: hash, text}); setDraft(text); setStatus({kind: "editing"});
      })
      .catch(() => {if (!controller.signal.aborted) setStatus({kind: "load-failed"});});
  };
  useEffect(() => {
    load(blobSha256);
    return () => request.current?.abort();
  }, [session, path]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {if (unsaved) {event.preventDefault(); event.returnValue = "";}};
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

  const save = () => {
    if (!available || status.kind === "saving") return;
    const text = draft;
    if (submission.current?.text !== text || submission.current.base !== base.blobSha256) {
      submission.current = {id: crypto.randomUUID(), text, base: base.blobSha256};
    }
    const {id} = submission.current;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setStatus({kind: "saving"});
    void (async (): Promise<Status> => {
      try {
        const response = await fetch(COLLECTION_WRITES_PATH, {method: "POST", credentials: "same-origin", signal: controller.signal,
          headers: {[SESSION_HEADER]: session, "content-type": "application/json"},
          body: collectionWriteBody(id, [{path, basedOnBlobSha256: base.blobSha256, text}], Date.now())});
        const outcome = parseCollectionWriteOutcome(response.status, await response.json().catch(() => null));
        if (!outcome.ok) return {kind: "not-saved", outcome};
        submission.current = null;
        setBase({blobSha256: await sha256(text), text});
        return {kind: "sent"};
      } catch {
        return {kind: "not-saved", outcome: {ok: false, outcome: "unknown"}};
      }
    })().then(next => {if (!controller.signal.aborted) setStatus(next);});
  };
  const leave = (action: () => void) => {if (unsaved) setLeaving(() => action); else action();};
  const saving = status.kind === "saving";

  return <div className="viewer">
    <header><div><p className="eyebrow">Shared by a dohc user</p><h1>{path}</h1></div>
      <div className="header-actions">
        <button className="handoff-button secondary" onClick={() => leave(onClose)}>Back to shared files</button>
        {available && status.kind !== "loading" && status.kind !== "load-failed" &&
          <button className="handoff-button primary" disabled={saving || !unsaved} onClick={save}>{saving ? "Saving…" : "Save"}</button>}
      </div></header>
    <main className="content collection-file-editor">
      {!available && <p role="alert">Editing is no longer available. Copy your text before closing this file.</p>}
      {status.kind === "loading" && <p role="status" className="muted">Opening the file…</p>}
      {status.kind === "load-failed" && <div className="download-card"><p>dohc could not open this file for editing. Retry or ask the owner for access.</p>
        {available && <button className="handoff-button secondary" onClick={() => load(base.blobSha256)}>Retry</button>}</div>}
      <StatusLine status={status} onReload={hash => leave(() => load(hash))}/>
      {status.kind !== "loading" && status.kind !== "load-failed" &&
        <textarea aria-label={path} spellCheck={false} value={draft} readOnly={!available || saving}
          onChange={event => {setDraft(event.target.value); if (!saving) setStatus({kind: "editing"});}}/>}
    </main>
    {leaving && <DiscardDraft cancel={() => setLeaving(null)} confirm={() => {const action = leaving; setLeaving(null); action();}}/>}
  </div>;
}

function StatusLine({status, onReload}: {status: Status; onReload(blobSha256: string): void}) {
  if (status.kind === "sent") {
    return <p role="status">Saved to the owner's workspace. Their computer applies it the next time it syncs.</p>;
  }
  if (status.kind !== "not-saved") return null;
  const failure = status.outcome;
  switch (failure.outcome) {
    case "stale":
      return <div role="alert"><p>This file changed after you opened it, so dohc did not save your text. Your text is still here.</p>
        {failure.currentBlobSha256
          ? <><p>Copy what you want to keep, then open the current file and make your change again.</p>
            <button className="handoff-button secondary" onClick={() => onReload(failure.currentBlobSha256!)}>Open current file</button></>
          : <p>The owner's workspace no longer has this file. Copy what you want to keep.</p>}</div>;
    case "refused":
      return <p role="alert">dohc did not save this change: {failure.reason}. Fix the file, then save again.</p>;
    case "unavailable":
      return <p role="alert">This link can no longer change this file. Copy your text before closing it.</p>;
    case "rate-limited":
      return <p role="alert">This link saved too often. Wait a minute, then save again.</p>;
    case "unknown":
      return <p role="alert">dohc could not confirm the save. Save again to finish it.</p>;
  }
}
