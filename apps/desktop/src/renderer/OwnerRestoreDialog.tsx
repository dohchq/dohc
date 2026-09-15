import {useEffect, useMemo, useRef, useState} from "react";
import {bridge} from "./bridge";
import {Overlay} from "./Overlay";
import {PrimaryButton, SecondaryButton} from "./ui/controls";
import {useRequestSequence} from "./useRequestSequence";
import {ipcErrorMessage} from "./ipcError";
import {ownerRestoreOutcomes} from "./ownerRestoreOutcomes";
import type {OwnerRestoreOptions, OwnerRestorePlan, OwnerRestoreReview, OwnerRestoreStatus} from "../ipc/ownerRestoreContract";

type State = {kind: "loading"} | {kind: "options"; options: OwnerRestoreOptions}
  | {kind: "stop"; plan: OwnerRestorePlan} | {kind: "review"; review: OwnerRestoreReview}
  | {kind: "pending"; message: string} | {kind: "error"; message: string} | {kind: "complete"};
const recipient = (row: {principalKind: string; email: string | null; userId: string | null}) =>
  row.principalKind === "link" ? "Anyone using this link" : row.email ?? `Account ${row.userId}`;

function ChangeList({label, events}: {label: string; events: OwnerRestoreReview["acceptedEvents"]}) {
  const [page, setPage] = useState(0), start = page * 50;
  if (!events.length) return null;
  return <details className="border-t border-line py-3">
    <summary className="cursor-pointer text-[13px] text-ink">{label} <span className="font-mono">({events.length})</span></summary>
    <ol className="space-y-2 pl-5 text-[12px] text-muted" start={start + 1}>
      {events.slice(start, start + 50).map(({metadata}) => {
        const {authority, receipt, receivedAtMs} = metadata.accepted;
        return <li key={receipt.deliveryId}>
          {authority.principalKind === "owner" ? "Owner" : authority.principalKind === "link" ? "Link participant" : `Account ${authority.principalId}`}
          <span> · {new Date(receivedAtMs).toLocaleString()}</span>
          <details><summary className="cursor-pointer">Change details</summary><pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(metadata, null, 2)}</pre></details>
        </li>;
      })}
    </ol>
    {events.length > 50 && <div className="flex gap-2"><SecondaryButton disabled={page === 0} onClick={() => setPage(page - 1)}>Previous changes</SecondaryButton><SecondaryButton disabled={start + 50 >= events.length} onClick={() => setPage(page + 1)}>More changes</SecondaryButton></div>}
  </details>;
}
function SourceList({label, sources}: {label: string; sources: OwnerRestoreReview["nativeSources"]}) {
  const [page, setPage] = useState(0), start = page * 50;
  if (!sources.length) return null;
  return <details className="border-t border-line py-3"><summary className="cursor-pointer text-[13px] text-ink">{label} <span className="font-mono">({sources.length})</span></summary>
    <p className="text-[12px] text-muted">These records identify local owner work. Their times do not establish an order against accepted changes.</p>
    <ul className="space-y-2 pl-5 text-[12px] text-muted">{sources.slice(start, start + 50).map(source => <li key={source.source.deliveryId}><details><summary className="cursor-pointer">Local owner work <span className="font-mono">{source.source.deliveryId}</span></summary><pre className="overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">{JSON.stringify(source, null, 2)}</pre></details></li>)}</ul>
    {sources.length > 50 && <div className="flex gap-2"><SecondaryButton disabled={page === 0} onClick={() => setPage(page - 1)}>Previous records</SecondaryButton><SecondaryButton disabled={start + 50 >= sources.length} onClick={() => setPage(page + 1)}>More records</SecondaryButton></div>}
  </details>;
}
function Review({review}: {review: OwnerRestoreReview}) {
  const outcomes = useMemo(() => ownerRestoreOutcomes(review), [review]);
  return <>
    <p className="text-[12px] text-muted">Restore point: {review.point.journalCursor === 0 ? "Before accepted edits" :
      <><time dateTime={new Date(review.selectedPointReceivedAtMs!).toISOString()}>{new Date(review.selectedPointReceivedAtMs!).toLocaleString()}</time> · <span className="font-mono">Change {review.point.journalCursor}</span></>}</p>
    <p className="text-[13px] text-muted">Restoring removes the changes listed below from this file.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-[12px] text-muted">Current file<textarea aria-label="Current file before restore" readOnly value={review.content.frozenMarkdown} className="mt-1 h-56 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-ink" /></label>
      <label className="text-[12px] text-muted">After restoring<textarea aria-label="File after restore" readOnly value={review.content.restoredMarkdown} className="mt-1 h-56 w-full rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-ink" /></label>
    </div>
    <ChangeList label="Removed by this restore" events={outcomes.removed} />
    <SourceList label="Local owner work removed by this restore" sources={outcomes.local} />
    <ChangeList label="Already excluded by an earlier restore" events={outcomes.excluded} />
    <SourceList label="Local owner work already excluded" sources={outcomes.earlierLocal} />
    <p className="text-[12px] text-muted">This restore keeps the selected version of the file.</p>
    <SourceList label="Kept at or before the selected point" sources={outcomes.kept} />
  </>;
}

export function OwnerRestoreDialog({workspaceId, path, onClose, onBeforeRestore, onRestored}: {
  workspaceId: string; path: string; onClose(): void; onBeforeRestore(): Promise<() => void>; onRestored(): void;
}) {
  const [state, setState] = useState<State>({kind: "loading"}), [busy, setBusy] = useState(false);
  const [grantId, setGrantId] = useState(""), [point, setPoint] = useState("");
  const request = useRequestSequence([workspaceId, path]), running = useRef(false), operation = useRef<OwnerRestoreStatus | null>(null);
  const current = (token: number) => request.isCurrent(token);
  async function perform(work: (token: number) => Promise<void>) {
    if (running.current) return;
    running.current = true; setBusy(true); const token = request.next();
    try {await work(token);} catch (error) {if (current(token)) setState({kind: "error", message: ipcErrorMessage(error)});}
    finally {if (current(token)) {running.current = false; setBusy(false);}}
  }
  async function load(token: number, beforeCursor?: number, grantCursor?: NonNullable<OwnerRestoreOptions["nextGrantCursor"]>) {
    const options = await bridge().ownerRestore({workspaceId, action: "options", path, ...(beforeCursor === undefined ? {} : {beforeCursor}), ...(grantCursor === undefined ? {} : {grantCursor})});
    if (!current(token)) return;
    if (options.pendingOperation) {
      const saved = await bridge().ownerRestore({workspaceId, action: "status", operationId: options.pendingOperation.operationId});
      if (!current(token)) return;
      operation.current = saved;
      setState({kind: "pending", message: "Access stopped. Continue reviewing or finishing this restore."});
    } else {
      if (grantCursor === undefined) setPoint("");
      setState(previous => {
        if (previous.kind !== "options") return {kind: "options", options};
        if (grantCursor !== undefined) return {kind: "options", options: {...previous.options,
          grants: [...new Map([...previous.options.grants, ...options.grants].map(grant => [grant.grantId, grant])).values()],
          nextGrantCursor: options.nextGrantCursor}};
        if (beforeCursor !== undefined) return {kind: "options", options: {...options,
          grants: previous.options.grants, nextGrantCursor: previous.options.nextGrantCursor}};
        return {kind: "options", options};
      });
    }
  }
  useEffect(() => {
    const token = request.next();
    operation.current = null; setGrantId(""); setPoint(""); running.current = true; setBusy(true); setState({kind: "loading"});
    void load(token).catch(error => {if (current(token)) setState({kind: "error", message: ipcErrorMessage(error)});})
      .finally(() => {if (current(token)) {running.current = false; setBusy(false);}});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, path]);
  async function review(token: number) {
    const saved = await bridge().ownerRestore({workspaceId, action: "status", operationId: operation.current!.operationId});
    if (!current(token)) return;
    operation.current = saved;
    const resumablePhase = saved.phase === "relay-admitted" || saved.phase === "native-applied" || saved.phase === "settled" || saved.phase === "resumed";
    if (saved.proposalDigest && resumablePhase) {
      await confirm(token, saved.proposalDigest); return;
    }
    let proposalDigest = saved.proposalDigest;
    if (!proposalDigest) {
      const prepared = await bridge().ownerRestore({workspaceId, action: "prepare", operationId: saved.operationId});
      if (!current(token)) return;
      operation.current = prepared.status;
      if (prepared.result.kind !== "prepared") {setState({kind: "pending", message: "The restore is waiting for the host. Retry when it is available."}); return;}
      proposalDigest = prepared.result.proposalDigest;
    }
    const checked = await bridge().ownerRestore({workspaceId, action: "review", operationId: saved.operationId});
    if (!current(token)) return;
    operation.current = checked.status;
    if (!checked.result || "kind" in checked.result) {setState({kind: "pending", message: "dohc could not prepare the full change review. Retry to review it again."}); return;}
    if (checked.result.operationId !== saved.operationId || checked.result.proposalDigest !== proposalDigest) throw Error("The restore review changed. Retry to review it again.");
    setState({kind: "review", review: checked.result});
  }
  async function confirm(token: number, proposalDigest: string) {
    const saved = operation.current!, release = await onBeforeRestore();
    try {
      if (!current(token)) return;
      const result = await bridge().ownerRestore({workspaceId, action: "confirm", operationId: saved.operationId, proposalDigest});
      if (!current(token)) return;
      operation.current = result.status;
      if (result.result.kind === "resumed" && result.status.phase === "resumed" && result.result.proposalDigest === proposalDigest) {
        setState({kind: "complete"}); onRestored();
      } else setState({kind: "pending", message: result.result.kind === "review-required"
        ? "The restore needs a new review. Retry to review it again."
        : "The restore has not finished. Retry to continue the same operation."});
    } finally {release();}
  }
  return <Overlay onClose={onClose} panelProps={{role: "dialog", "aria-modal": true, "aria-labelledby": "owner-restore-title", "data-testid": "owner-restore-dialog",
    className: "dohc-elevated dohc-pop-in w-[min(760px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-5"}}>
    <h2 id="owner-restore-title" className="m-0 text-sm font-semibold text-ink">{state.kind === "stop" ? "Stop access before restoring?" : state.kind === "complete" ? "File restored" : "Restore shared file"}</h2>
    <p className="break-all font-mono text-[12px] text-muted">{path}</p>
    <div role="status" aria-live="polite">{busy ? <p className="text-[12px] text-muted">{state.kind === "loading" ? "Loading restore choices…" : "Preparing the restore…"}</p> : null}</div>
    {state.kind === "options" && <div className="space-y-3">
      <p className="text-[13px] text-muted">Choose the access to stop and the accepted change to restore to.</p>
      <label className="block text-[12px] text-muted">Access<select aria-label="Access to stop" disabled={busy} value={grantId} onChange={event => setGrantId(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"><option value="">Choose access</option>{state.options.grants.map(grant => <option key={grant.grantId} value={grant.grantId}>{recipient(grant)}</option>)}</select></label>
      <label className="block text-[12px] text-muted">Restore point<select aria-label="Shared restore point" disabled={busy} value={point} onChange={event => setPoint(event.target.value)} className="mt-1 w-full rounded-md border border-line bg-bg p-2 text-[13px] text-ink"><option value="">Choose a change</option>{state.options.points.map(p => <option key={p.cursor} value={p.cursor}>{p.kind === "baseline" ? "Before accepted edits" : `${new Date(p.receivedAtMs!).toLocaleString()} · Change ${p.cursor}`}</option>)}</select></label>
      {!state.options.grants.length && state.options.nextGrantCursor === null && <p className="text-[12px] text-muted">No active edit access is available for this file. Close this review.</p>}
      {state.options.nextGrantCursor !== null && <SecondaryButton disabled={busy} onClick={() => void perform(token => load(token, undefined, state.options.nextGrantCursor!))}>More access choices</SecondaryButton>}
      {state.options.nextBeforeCursor !== null && <SecondaryButton disabled={busy} onClick={() => void perform(token => load(token, state.options.nextBeforeCursor!))}>Earlier changes</SecondaryButton>}
    </div>}
    {state.kind === "stop" && <>
      <p className="text-[13px] text-ink">This access stays stopped, even if you decline the restore.</p>
      {state.plan.recipients.some(row => row.principalKind === "link") && <p className="text-[13px] text-muted">The old link will stop working.</p>}
      <p className="text-[13px] text-muted">Restoring is a separate decision. If you decline, the file stays unchanged. Share again to restore access.</p>
      <ul className="space-y-1 pl-5 text-[13px] text-muted">{state.plan.recipients.map(row => <li key={row.grantId}>{recipient(row)}</li>)}</ul>
      <p className="text-[13px] text-muted">Next, review the changes to remove before restoring the file.</p>
    </>}
    {state.kind === "review" && <Review key={state.review.proposalDigest} review={state.review} />}
    {state.kind === "pending" || state.kind === "error" ? <p role="alert" className="text-[13px] text-muted">{state.message}</p> : null}
    {operation.current && state.kind !== "complete" && <p className="text-[12px] text-muted">Access has stopped. Closing this review does not restore the old access.</p>}
    {state.kind === "complete" && <p className="text-[13px] text-muted">The file has been restored. Share again when you want to give access.</p>}
    <div className="mt-4 flex justify-end gap-2">
      <SecondaryButton onClick={onClose}>{state.kind === "stop" ? "Cancel" : "Close"}</SecondaryButton>
      {state.kind === "options" && <PrimaryButton disabled={busy || !grantId || point === ""} onClick={() => void perform(async token => {
        const selected = state.options.points.find(p => String(p.cursor) === point)!, grant = state.options.grants.find(g => g.grantId === grantId)!;
        const plan = await bridge().ownerRestore({workspaceId, action: "plan", document: state.options.document, shareId: grant.shareId, grantId,
          restorePointCursor: selected.cursor, restorePointReceiptDigest: selected.receiptDigest});
        if (current(token)) setState({kind: "stop", plan});
      })}>Review affected access</PrimaryButton>}
      {state.kind === "stop" && <PrimaryButton disabled={busy} onClick={() => void perform(async token => {
        const stopped = await bridge().ownerRestore({workspaceId, action: "begin", intent: state.plan.intent});
        if (!current(token)) return; operation.current = stopped; await review(token);
      })}>Stop access</PrimaryButton>}
      {state.kind === "review" && <PrimaryButton disabled={busy} onClick={() => void perform(token => confirm(token, state.review.proposalDigest))}>Restore file</PrimaryButton>}
      {(state.kind === "pending" || state.kind === "error") && <PrimaryButton disabled={busy} onClick={() => void perform(token => operation.current ? review(token) : load(token))}>Retry</PrimaryButton>}
    </div>
  </Overlay>;
}
