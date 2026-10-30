import { useContext, useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { DatasetPermissionsPage, DatasetPlace } from "@dohc/cli/dataset";
import type { RelayShareGrantedRow } from "../ipc/bridgeContract";
import { namingCollectionMove, readError, UNKNOWN_ERROR_WORDS, withErrorWords } from "../ipc/errorWords";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { CollectionMoveNote } from "./collections/CollectionMoveNote";
import { inputClass } from "./collections/FieldForm";
import { PrimaryButton, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { ShellErrorReporter, type ReportShellFailure } from "./shell/useShellError";

interface Props {
  workspaceId: string; datasetPath: string;
  dataset: DatasetDescription;
  onClose(): void;
  onError(fallback: string, cause: unknown, retry?: (() => void) | null): void;
  /** Removes the row in Notices a report with this identity left. */
  onSettled?(identity: string): void;
  /** A save moved this Collection to the server. */
  onMoved?(): void;
}
type Target = { workspaceId: string; datasetPath: string; expectedDatasetId: string };
type Change = { principalKey: string } | { principalKey?: undefined; grantId: string; person: string; operationIds: string[]; moveToServer: boolean };
type Failure = { principalKey?: string; words: string };
// One row in Notices for this Collection's failed access change, which the next change that succeeds removes,
// so an older Try again never undoes newer access. A save names a person by grant and a removal by key, so the row can't be per person.
const changeIdentity = (datasetId: string) => `collection-access:${datasetId}`;
async function changeAccess(target: Target, dataset: DatasetDescription, change: Change) {
  const result = await bridge().dataset(change.principalKey !== undefined ? { ...target, action: "removeGrant", principalKey: change.principalKey } : {
    ...target, action: "setGrant", grantId: change.grantId, grant: { revision: dataset.revision, revisionSha256: dataset.revisionSha256,
      operationIds: change.operationIds, discover: true }, ...(change.moveToServer ? { moveToServer: true as const } : {}),
  });
  if (result.kind !== "grant-updated") throw Error("dohc could not confirm Collection access. Try again.");
}
// A change that answered after its dialog closed takes a toast and a row, whose Try again runs it again.
function reportClosed(report: ReportShellFailure, run: () => Promise<void>, change: Change, dataset: DatasetDescription, cause: unknown) {
  report({ title: change.principalKey !== undefined ? "Access wasn't removed" : `Access wasn't saved for ${change.person}`,
    message: readError(namingCollectionMove(cause, dataset.name)).words ?? UNKNOWN_ERROR_WORDS, cause, identity: changeIdentity(dataset.datasetId),
    retry: () => { void run().catch((error: unknown) => reportClosed(report, run, change, dataset, error)); } });
}
export function CollectionPermissionsDialog(props: Props) {
  // New rules remount the form below while the dialog stays open, so whether
  // it is open, and the failure it shows in place, live here.
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
  const [failure, setFailure] = useState<Failure | null>(null);
  return <Permissions key={`${props.workspaceId}:${props.dataset.datasetId}:${props.dataset.revisionSha256}`} {...props} open={open} failure={failure} onFailure={setFailure} />;
}
function Permissions({ workspaceId, datasetPath, dataset, onClose, onError, onSettled, onMoved, open, failure, onFailure }: Props & {
  open: { readonly current: boolean }; failure: Failure | null; onFailure(failure: Failure | null): void;
}) {
  const [page, setPage] = useState<DatasetPermissionsPage | null>(null);
  const [place, setPlace] = useState<DatasetPlace | null>(null);
  const [recipients, setRecipients] = useState<RelayShareGrantedRow[]>([]);
  const [grantId, setGrantId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const report = useContext(ShellErrorReporter);
  const alive = useRef(true), request = useRef(0), locked = useRef(false);
  const target: Target = { workspaceId, datasetPath, expectedDatasetId: dataset.datasetId };
  const actions = dataset.operations.filter(operation => operation.access !== "owner");
  // Saving moves a Collection on this computer to the server, which its owner agrees to by saving.
  const moving = place?.kind === "here" ? place.server : null;
  async function load(after?: string) {
    if (!alive.current || locked.current) return;
    const token = ++request.current; setBusy(true);
    try {
      const [permissions, shares] = await Promise.all([
        bridge().dataset({ ...target, action: "permissions", ...(after ? { after } : {}), limit: 50 }),
        bridge().listRelayShares(),
      ]);
      if (!alive.current || token !== request.current) return;
      if (permissions.kind !== "permissions") throw Error("dohc could not read Collection access. Try again.");
      setPage({ permissions: permissions.permissions, nextCursor: permissions.nextCursor }); setPlace(permissions.place ?? null);
      setRecipients(shares.granted.filter(row => row.workspaceId === workspaceId && row.revokedAtMs === null && row.recipientUserId));
    } catch (cause) {
      if (alive.current && token === request.current) onError("Could not load Collection access.", cause, () => { void load(after); });
    } finally { if (alive.current && token === request.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; request.current++; }; }, []);
  async function change(principalKey?: string) {
    if (!alive.current || locked.current) return;
    const recipient = recipients.find(row => row.grantId === grantId);
    const asked: Change = principalKey ? { principalKey }
      : { grantId, person: recipient?.recipientEmail ?? recipient?.recipientUserId ?? grantId, operationIds: selected, moveToServer: moving !== null };
    const run = () => changeAccess(target, dataset, asked);
    locked.current = true; const token = ++request.current; setBusy(true); onFailure(null);
    try {
      await run();
      onSettled?.(changeIdentity(dataset.datasetId));
      if (asked.principalKey === undefined && asked.moveToServer) onMoved?.();
      if (!alive.current || token !== request.current) return;
      setGrantId(""); setSelected([]); locked.current = false; await load();
    } catch (cause) {
      // While the dialog is open, it says in place why its own save or removal failed.
      if (open.current) onFailure({ ...(principalKey ? { principalKey } : {}), words: withErrorWords(principalKey ? "Access wasn't removed." : "Access wasn't saved.", cause) });
      else if (report) reportClosed(report, run, asked, dataset, cause);
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <Overlay onClose={busy ? undefined : onClose}><section role="dialog" aria-modal="true" aria-labelledby="collection-access-title"
    className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-140 max-w-[90vw] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5">
    <h2 id="collection-access-title" className="m-0 text-base font-semibold text-ink">Collection access</h2>
    <p className="m-0 text-[13px] text-muted">Choose who can use this Collection and which actions they can run.</p>
    {place?.kind === "server" ? <p className="m-0 text-[12px] text-muted">This Collection is on {place.host}.</p> : null}
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (!busy) void change(); }}>
      <label className="text-[12px] text-muted">Person<select aria-label="Collection access person" value={grantId} disabled={busy}
        onChange={event => setGrantId(event.target.value)} className={`${inputClass} mt-1`}>
        <option value="">Choose a workspace recipient</option>
        {recipients.map(row => <option key={row.grantId} value={row.grantId}>{row.recipientEmail ?? row.recipientUserId} · {row.grantId.slice(0, 8)}</option>)}
      </select></label>
      {!recipients.length && !busy ? <p className="m-0 text-[12px] text-muted">Share a workspace file or folder with a person first. They must accept the invitation.</p> : null}
      <fieldset disabled={busy} className="flex flex-col gap-2 border-0 p-0"><legend className="mb-2 text-[12px] text-muted">Allowed actions</legend>
        {actions.map(operation => <label key={operation.operationId} className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={selected.includes(operation.operationId)} onChange={event => setSelected(previous => event.target.checked
            ? [...previous, operation.operationId] : previous.filter(id => id !== operation.operationId))} />
          {operation.label}<span className="text-[12px] text-muted">{operation.readOnly ? "Read" : "Change records"}</span>
        </label>)}
        {!actions.length ? <p className="m-0 text-[12px] text-muted">These rules contain no actions that can be shared. Review the Collection source to add one.</p> : null}
      </fieldset>
      {moving ? <CollectionMoveNote action="Saving" server={moving} />
        : <p className="m-0 text-[12px] text-muted">Saving replaces this person's allowed actions for this Collection. Source permissions remain separate.</p>}
      {/* aria-disabled, not disabled, while busy, so the pressed button keeps focus and can retry. */}
      <div><p role="status" aria-live="polite" className="m-0 mb-2 text-[12px] text-danger empty:mb-0">{failure && !failure.principalKey ? failure.words : null}</p>
        <PrimaryButton type="submit" disabled={!grantId || !selected.length} aria-disabled={busy || undefined}
          className="aria-disabled:cursor-wait aria-disabled:opacity-50">{moving ? "Move and save access" : "Save access"}</PrimaryButton></div>
    </form>
    <div className="flex flex-col gap-2"><h3 className="m-0 text-sm font-semibold text-ink">People and apps with access</h3>
      {!page ? busy ? <SkeletonRows rows={2} label="Loading access…" /> : <p className="m-0 text-[12px] text-muted">Load access to review people and apps.</p> : !page.permissions.length ? <p className="m-0 text-[12px] text-muted">Only you have access.</p> : page.permissions.map(permission =>
        <div key={`${permission.kind}:${permission.principal}`} className="border-b border-line py-2">
          {permission.kind === "data" ? <p role="status" aria-live="polite" className="m-0 mb-1 text-[12px] text-danger empty:mb-0">
            {failure?.principalKey === permission.principal ? failure.words : null}</p> : null}
          <div className="flex items-center justify-between gap-3"><div className="min-w-0 text-[12px] text-ink"><span>{permission.kind === "app" ? "App" : "Person"}{permission.current ? "" : " · Rules changed"}</span>
            <div className="truncate font-mono text-muted" title={permission.principal}>{permission.principal}</div>
            <div className="text-muted">{permission.metadata.operationIds.length} allowed actions</div></div>
          {permission.kind === "data" ? <SecondaryButton aria-disabled={busy || undefined} className="aria-disabled:cursor-wait aria-disabled:opacity-50"
            onClick={() => { if (!busy) void change(permission.principal); }}>Remove access</SecondaryButton> : null}
        </div></div>)}
      <div className="flex gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton>
        {page?.nextCursor ? <SecondaryButton disabled={busy} onClick={() => void load(page.nextCursor!)}>Next</SecondaryButton> : null}</div>
    </div>
    <div className="flex justify-end"><SecondaryButton disabled={busy} onClick={onClose}>Close</SecondaryButton></div>
  </section></Overlay>;
}
