import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OwnerAppResponsesResult } from "@dohc/cli/app-responses";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { SecondaryButton } from "./ui/controls";

type Page = Extract<OwnerAppResponsesResult, { action: "list" }>;
type Undo = Extract<OwnerAppResponsesResult, { action: "undo" }>;
type Selection = { principalId: string; operationId: string; cursor?: string };
function resultFrom(value: unknown) {
  const parsed = OwnerAppResponsesResult.safeParse(value);
  if (!parsed.success) throw new Error("dohc could not read the response result. Try again.");
  return parsed.data;
}

export function OwnerAppResponses(props: { workspaceId: string; grantId: string; onBusyChange?: (busy: boolean) => void }) {
  return <ResponsePanel key={`${props.workspaceId}\0${props.grantId}`} {...props} />;
}

function ResponsePanel({ workspaceId, grantId, onBusyChange }: { workspaceId: string; grantId: string; onBusyChange?: (busy: boolean) => void }) {
  const api = useRef(bridge()).current;
  const current = useRef(true);
  const request = useRef(0);
  const focusAfterConfirm = useRef<HTMLButtonElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterUndo = useRef(false);
  const [page, setPage] = useState<Page | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Selection | null>(null);
  const [continuation, setContinuation] = useState<Selection | null>(null);
  const [result, setResult] = useState<Undo | null>(null);
  useEffect(() => { current.current = true; return () => { current.current = false; request.current++; }; }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    if (!busy && focusAfterUndo.current) { focusAfterUndo.current = false; heading.current?.focus(); }
  }, [busy]);

  async function list(cursor?: string) {
    if (busy) return;
    const mine = ++request.current;
    setBusy(true); setError(null); setResult(null);
    try {
      const next = resultFrom(await api.ownerAppResponses({ action: "list", workspaceId, grantId, limit: 100,
        ...(cursor ? { afterAcceptanceId: cursor } : {}) }));
      if (!current.current || request.current !== mine) return;
      if (next.action !== "list") throw new Error("dohc could not load responses. Try again.");
      setPage(next);
    } catch (cause) {
      if (current.current && request.current === mine) setError(ipcErrorMessage(cause, "dohc could not load responses. Try again."));
    } finally { if (current.current && request.current === mine) setBusy(false); }
  }

  async function undo(selection: Selection) {
    if (busy) return;
    const mine = ++request.current;
    setBusy(true); setError(null); setResult(null); setConfirmation(null);
    try {
      const next = resultFrom(await api.ownerAppResponses({ action: "undo", workspaceId, grantId,
        publicPrincipalId: selection.principalId, operationId: selection.operationId, limit: 100,
        ...(selection.cursor ? { afterAcceptanceId: selection.cursor } : {}) }));
      if (!current.current || request.current !== mine) return;
      if (next.action !== "undo") throw new Error("dohc could not confirm which responses were removed. Try again.");
      setResult(next);
      setContinuation(next.items.some(row => row.status === "failed") ? selection : next.nextCursor ? { ...selection, cursor: next.nextCursor } : null);
    } catch (cause) {
      if (current.current && request.current === mine) {
        setContinuation(selection);
        setError(ipcErrorMessage(cause, "dohc could not confirm which responses were removed. Retry to check the same responses."));
      }
    } finally {
      if (current.current && request.current === mine) { focusAfterUndo.current = true; setBusy(false); }
    }
  }

  const holders = [...new Set(page?.acceptances.map(row => row.publicPrincipalId) ?? [])];
  const counts = result && {
    deleted: result.items.filter(row => row.status === "deleted").length,
    absent: result.items.filter(row => row.status === "already-absent").length,
    conflict: result.items.filter(row => row.status === "conflict").length,
    failed: result.items.filter(row => row.status === "failed").length,
  };
  return <section aria-label="App responses" className="border-t border-line pt-3">
    <div className="flex items-center justify-between gap-2">
      <h3 ref={heading} tabIndex={-1} className="m-0 text-[13px] font-medium text-ink">App responses</h3>
      <SecondaryButton disabled={busy} onClick={() => void list()}>{page ? "Reload responses" : "Load responses"}</SecondaryButton>
    </div>
    <p className="mt-2 text-[12px] text-muted">Review the response files before removing a link holder’s responses.</p>
    {busy ? <p role="status" className="text-[12px] text-muted">{confirmation ? "Removing responses…" : "Updating responses…"}</p> : null}
    {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    {page?.acceptances.length === 0 ? <p className="text-[12px] text-muted">No responses in this page. Reload to check for new responses.</p> : null}
    <ul className="m-0 list-none space-y-3 p-0">
      {holders.map(principalId => {
        const rows = page!.acceptances.filter(row => row.publicPrincipalId === principalId);
        return <li key={principalId} className="rounded-md border border-line p-2">
          <p className="m-0 break-all text-[12px] text-ink">Link holder <span className="font-mono">{principalId}</span></p>
          <ul className="my-2 list-none p-0 text-[12px] text-muted">
            {rows.map(row => <li key={row.acceptanceId} className="break-all"><span className="font-mono">{row.path}</span> · {new Date(row.acceptedAtMs).toLocaleString()}</li>)}
          </ul>
          <SecondaryButton disabled={busy || continuation !== null} onClick={event => {
            focusAfterConfirm.current = event.currentTarget;
            setConfirmation({ principalId, operationId: crypto.randomUUID() });
          }}>Remove this holder’s responses</SecondaryButton>
        </li>;
      })}
    </ul>
    {page?.nextAcceptanceId ? <SecondaryButton disabled={busy} onClick={() => void list(page.nextAcceptanceId!)}>Next responses</SecondaryButton> : null}
    {counts ? <div role="status" className="mt-3 text-[12px] text-muted">
      <p>{counts.deleted} removed. {counts.absent} already absent. {counts.conflict} conflicts kept. {counts.failed} failed.</p>
      {counts.deleted > 0 ? <p>Restore removed files from workspace history.</p> : null}
      {counts.failed > 0 ? <p>Retry this batch to check the failed responses.</p> : null}
    </div> : null}
    {continuation ? <div className="flex items-center gap-2">
      <SecondaryButton disabled={busy} onClick={() => void undo(continuation)}>{error || (counts?.failed ?? 0) > 0 ? "Retry removal" : "Continue removing responses"}</SecondaryButton>
      <SecondaryButton disabled={busy} onClick={() => setContinuation(null)}>Stop here</SecondaryButton>
    </div> : null}
    {confirmation ? createPortal(<ConfirmDialog title="Remove this holder’s responses?" confirmLabel="Remove responses"
      testId="app-responses-confirm" cancelTestId="app-responses-cancel" confirmTestId="app-responses-remove"
      onCancel={() => { setConfirmation(null); focusAfterConfirm.current?.focus(); }} onConfirm={() => void undo(confirmation)}>
      <p className="text-[13px] text-muted">This removes up to 100 responses from this holder on this link, including responses outside this page.</p>
      <p className="text-[13px] text-muted">Files with conflicts stay in place. You can restore removed files from workspace history.</p>
      <p className="break-all font-mono text-[12px] text-muted">{confirmation.principalId}</p>
    </ConfirmDialog>, document.body) : null}
  </section>;
}
