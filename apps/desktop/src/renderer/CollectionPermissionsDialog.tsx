import { useEffect, useRef, useState } from "react";
import type { DatasetDescription } from "@dohc/security-contract/dataset";
import type { DatasetPermissionsPage } from "@dohc/cli/dataset";
import type { RelayShareGrantedRow } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { Overlay } from "./Overlay";
import { inputClass } from "./collections/FieldForm";
import { PrimaryButton, SecondaryButton } from "./ui/controls";

interface Props {
  workspaceId: string; datasetPath: string;
  dataset: DatasetDescription;
  onClose(): void;
  onError(fallback: string, cause: unknown, retry?: (() => void) | null): void;
}
export function CollectionPermissionsDialog(props: Props) {
  return <Permissions key={`${props.workspaceId}:${props.dataset.datasetId}:${props.dataset.revisionSha256}`} {...props} />;
}
function Permissions({ workspaceId, datasetPath, dataset, onClose, onError }: Props) {
  const [page, setPage] = useState<DatasetPermissionsPage | null>(null);
  const [recipients, setRecipients] = useState<RelayShareGrantedRow[]>([]);
  const [grantId, setGrantId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true), request = useRef(0), locked = useRef(false);
  const target = { workspaceId, datasetPath, expectedDatasetId: dataset.datasetId };
  const actions = dataset.operations.filter(operation => operation.access !== "owner");
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
      setPage({ permissions: permissions.permissions, nextCursor: permissions.nextCursor });
      setRecipients(shares.granted.filter(row => row.workspaceId === workspaceId && row.revokedAtMs === null && row.recipientUserId));
    } catch (cause) {
      if (alive.current && token === request.current) onError("Could not load Collection access.", cause, () => { void load(after); });
    } finally { if (alive.current && token === request.current) setBusy(false); }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; request.current++; }; }, []);
  async function change(principalKey?: string) {
    if (!alive.current || locked.current) return;
    locked.current = true; const token = ++request.current; setBusy(true);
    try {
      const result = await bridge().dataset(principalKey ? { ...target, action: "removeGrant", principalKey } : {
        ...target, action: "setGrant", grantId, grant: { revision: dataset.revision, revisionSha256: dataset.revisionSha256,
          operationIds: selected, discover: true },
      });
      if (!alive.current || token !== request.current) return;
      if (result.kind !== "grant-updated") throw Error("dohc could not confirm Collection access. Try again.");
      setGrantId(""); setSelected([]); locked.current = false; await load();
    } catch (cause) {
      if (alive.current && token === request.current) onError("Could not update Collection access.", cause, () => { void change(principalKey); });
    } finally { locked.current = false; if (alive.current) setBusy(false); }
  }
  return <Overlay onClose={busy ? undefined : onClose}><section role="dialog" aria-modal="true" aria-labelledby="collection-access-title"
    className="dohc-elevated dohc-pop-in flex max-h-[85vh] w-140 max-w-[90vw] flex-col gap-4 overflow-auto rounded-xl border border-line bg-panel p-5">
    <h2 id="collection-access-title" className="m-0 text-sm font-semibold text-ink">Collection access</h2>
    <p className="m-0 text-[13px] text-muted">Choose who can use this Collection and which actions they can run.</p>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void change(); }}>
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
      <p className="m-0 text-[12px] text-muted">Saving replaces this person's allowed actions for this Collection. Source permissions remain separate.</p>
      <div><PrimaryButton type="submit" disabled={busy || !grantId || !selected.length}>Save access</PrimaryButton></div>
    </form>
    <div className="flex flex-col gap-2"><h3 className="m-0 text-sm font-semibold text-ink">People and apps with access</h3>
      {!page ? <p className="m-0 text-[12px] text-muted">{busy ? "Loading access…" : "Load access to review people and apps."}</p> : !page.permissions.length ? <p className="m-0 text-[12px] text-muted">Only you have access.</p> : page.permissions.map(permission =>
        <div key={`${permission.kind}:${permission.principal}`} className="flex items-center justify-between gap-3 border-b border-line py-2">
          <div className="min-w-0 text-[12px] text-ink"><span>{permission.kind === "app" ? "App" : "Person"}{permission.current ? "" : " · Rules changed"}</span>
            <div className="truncate font-mono text-muted" title={permission.principal}>{permission.principal}</div>
            <div className="text-muted">{permission.metadata.operationIds.length} allowed actions</div></div>
          {permission.kind === "data" ? <SecondaryButton disabled={busy} onClick={() => void change(permission.principal)}>Remove access</SecondaryButton> : null}
        </div>)}
      <div className="flex gap-2"><SecondaryButton disabled={busy} onClick={() => void load()}>Refresh</SecondaryButton>
        {page?.nextCursor ? <SecondaryButton disabled={busy} onClick={() => void load(page.nextCursor!)}>Next</SecondaryButton> : null}</div>
    </div>
    <div className="flex justify-end"><SecondaryButton disabled={busy} onClick={onClose}>Close</SecondaryButton></div>
  </section></Overlay>;
}
