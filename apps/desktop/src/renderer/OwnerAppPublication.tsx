import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import type { RelayShareLinkRow } from "../ipc/bridgeContract";
import { OwnerAppPublicationResult } from "../ipc/ownerAppPublicationContract";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { OwnerAppResponses } from "./OwnerAppResponses";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";

type Prepared = Extract<OwnerAppPublicationResult, { kind: "prepared" }>;
type Publication = Extract<OwnerAppPublicationResult, { kind: "listed" }>["publications"][number];
type ActiveLink = RelayShareLinkRow & { selector: NonNullable<RelayShareLinkRow["selector"]> };

function verifiedPrepared(result: OwnerAppPublicationResult): Prepared {
  const checked = OwnerAppPublicationResult.safeParse(result);
  if (!checked.success || checked.data.kind !== "prepared") throw new Error("dohc could not verify this app's data access. Prepare the app again.");
  return checked.data;
}

type PublicationProps = { workspaceId: string; appRoot: string; onShareSource?: () => void };

export function OwnerAppPublication(props: PublicationProps) {
  return <PublicationControl key={`${props.workspaceId}\0${props.appRoot}`} {...props} />;
}

function PublicationControl(props: PublicationProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  return <>
    <IconButton ref={trigger} data-testid="site-preview-publish" aria-label="Publish app" title="Publish app" className="size-7" onClick={() => setOpen(true)}>
      <Upload size={13} aria-hidden />
    </IconButton>
    {open ? <PublicationDialog {...props} onClose={close} /> : null}
  </>;
}

function linkLabel(link: ActiveLink) {
  const paths = link.selector.paths.join(", ") || "Workspace";
  const version = link.selector.versionId ? ` · Version ${link.selector.versionId}` : "";
  return `${paths}${version} · ${link.access} · ${link.grantId.slice(0, 8)}`;
}

function PublicationDialog(props: {
  workspaceId: string;
  appRoot: string;
  onShareSource?: () => void;
  onClose: () => void;
}) {
  const [links, setLinks] = useState<ActiveLink[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [preparedLink, setPreparedLink] = useState("");
  const [busy, setBusy] = useState<"prepare" | "approve" | "withdraw" | null>(null);
  const [busyPublicationId, setBusyPublicationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [pendingWithdraw, setPendingWithdraw] = useState<Publication | null>(null);
  const [publicationsLoading, setPublicationsLoading] = useState(true);
  const [publicationsError, setPublicationsError] = useState<string | null>(null);
  const [publicationsReload, setPublicationsReload] = useState(0);
  const alive = useRef(true);
  const request = useRef(0);
  const candidate = useRef<Prepared | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const api = useRef(bridge()).current;
  const selectedLink = links.find(link => link.grantId === selected);
  const committing = busy === "approve" || busy === "withdraw";

  useEffect(() => { heading.current?.focus(); }, [prepared]);

  const cancel = (value: Prepared | null) => {
    if (value) void api.publishOwnerApp({ action: "cancel", workspaceId: props.workspaceId, approvalId: value.approvalId }).catch(() => undefined);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
      cancel(candidate.current);
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setLoadError(null);
    void (async () => {
      const rows: ActiveLink[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.listRelayShareLinks({ workspaceId: props.workspaceId, ...(cursor ? { cursor } : {}) });
        if (!current) return;
        for (const row of page.links) {
          if (row.status === "active" && row.revokedAtMs === null && row.selector !== null &&
              (row.selector.paths.length === 0 || row.selector.paths.some(path => props.appRoot === path || props.appRoot.startsWith(path + "/"))) &&
              !rows.some(link => link.grantId === row.grantId)) rows.push(row as ActiveLink);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("The link list changed. Reload the links.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (current) { setLinks(rows); setSelected(value => rows.some(link => link.grantId === value) ? value : ""); }
    })().catch(error => { if (current) setLoadError(ipcErrorMessage(error, "dohc could not load the links. Try again.")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, props.workspaceId, props.appRoot, reload]);

  useEffect(() => {
    let current = true;
    setPublicationsLoading(true); setPublicationsError(null);
    void (async () => {
      const rows: Publication[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.publishOwnerApp({ action: "list", workspaceId: props.workspaceId, appRoot: props.appRoot, ...(cursor ? { cursor } : {}) });
        if (!current) return;
        if (page.kind !== "listed") throw new Error("dohc could not load app publications. Reload the publications.");
        for (const row of page.publications) {
          if ((row.manifestUnavailable || row.appRoot === props.appRoot) && !rows.some(value => value.publicationId === row.publicationId)) rows.push(row);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("The publication list changed. Reload the publications.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (current) setPublications(rows);
    })().catch(error => { if (current) setPublicationsError(ipcErrorMessage(error, "dohc could not load app publications. Reload the publications.")); })
      .finally(() => { if (current) setPublicationsLoading(false); });
    return () => { current = false; };
  }, [api, props.workspaceId, props.appRoot, publicationsReload]);

  const prepare = async () => {
    if (busy || !selectedLink) return;
    const mine = ++request.current;
    setBusy("prepare"); setError(null); setNotice(null);
    try {
      const result = await api.publishOwnerApp({ action: "prepare", workspaceId: props.workspaceId, appRoot: props.appRoot, shareId: selectedLink.shareId, grantId: selectedLink.grantId });
      if (!alive.current || mine !== request.current) { if (result.kind === "prepared") cancel(result); return; }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not prepare this app. Try again.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(false);
      setPreparedLink(linkLabel(selectedLink));
    } catch (error) {
      if (alive.current && mine === request.current) { cancel(candidate.current); candidate.current = null; setError(ipcErrorMessage(error, "dohc could not prepare this app. Try again.")); }
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };

  const reviewReactivation = async (publication: Publication) => {
    if (busy || publication.manifestUnavailable || publication.active) return;
    const mine = ++request.current;
    setBusy("prepare"); setBusyPublicationId(publication.publicationId); setError(null); setNotice(null);
    try {
      const result = await api.publishOwnerApp({ action: "reviewReactivation", workspaceId: props.workspaceId, publicationId: publication.publicationId });
      if (!alive.current || mine !== request.current) { if (result.kind === "prepared") cancel(result); return; }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not load this publication. Reload the publications.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(true);
      setPreparedLink(`Link ${publication.grantId}`);
    } catch (error) {
      if (alive.current && mine === request.current) { cancel(candidate.current); candidate.current = null; setError(ipcErrorMessage(error, "dohc could not load this publication. Reload the publications.")); setPublicationsReload(value => value + 1); }
    } finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };

  const approve = async () => {
    if (busy || !prepared) return;
    const mine = ++request.current;
    setBusy("approve"); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "approve", workspaceId: props.workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published") throw new Error("dohc could not confirm publication. Reload the app publications.");
      candidate.current = null;
      setPublicationsReload(value => value + 1);
      setPrepared(null);
      setNotice(reactivating ? "App republished." : "App published on the selected link.");
    } catch (error) {
      if (alive.current && mine === request.current) {
        cancel(prepared);
        candidate.current = null;
        setPrepared(null);
        setPublicationsReload(value => value + 1);
        setError(ipcErrorMessage(error, "dohc could not confirm publication. Reload the app publications."));
      }
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };

  const withdraw = async (publication: Publication) => {
    if (busy) return;
    const mine = ++request.current;
    setBusy("withdraw"); setBusyPublicationId(publication.publicationId); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "withdraw", workspaceId: props.workspaceId, publicationId: publication.publicationId, expectedAuthorityRevision: publication.authorityRevision });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "withdrawn") throw new Error("dohc could not confirm that this publication ended. Try again.");
      setPublicationsReload(value => value + 1);
      setNotice("App unpublished. The share link still works for its other shared content.");
    } catch (error) { if (alive.current && mine === request.current) { setError(ipcErrorMessage(error, "dohc could not unpublish the app. Try again.")); setPublicationsReload(value => value + 1); } }
    finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };

  const back = () => {
    cancel(candidate.current); candidate.current = null; setPrepared(null); setError(null);
  };
  const closeWithdrawal = () => {
    setPendingWithdraw(null);
    heading.current?.focus();
  };

  return <><Overlay onClose={committing ? undefined : props.onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="app-publication-title" data-testid="app-publication-dialog"
      className="dohc-elevated flex max-h-[calc(100vh-128px)] w-[min(560px,calc(100vw-32px))] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-panel p-5">
      <header className="flex items-center gap-2">
        <h2 ref={heading} tabIndex={-1} id="app-publication-title" className="m-0 flex-1 text-sm font-semibold text-ink">{prepared ? "Review app publication" : "Publish app"}</h2>
        <IconButton aria-label="Close publication" disabled={committing} onClick={props.onClose}><X size={14} aria-hidden /></IconButton>
      </header>
      <p className="m-0 break-all font-mono text-[12px] text-muted">{props.appRoot}</p>
      {notice ? <p role="status" className="m-0 text-[13px] text-ink">{notice}</p> : null}
      {error ? <p role="alert" className="m-0 text-[13px] text-danger">{error}</p> : null}
      {prepared ? <>
        <p className="m-0 text-[13px] text-ink">{reactivating ? "Republish this stored revision. It does not include later source edits." : "Publish this captured app. Later source edits need a new publication."}</p>
        <div className="text-[12px] text-muted"><span className="font-medium text-ink">Link</span><p className="m-0 break-words">{preparedLink}</p></div>
        <div><h3 className="m-0 text-[13px] font-medium text-ink">Files included</h3>
          <ul data-testid="app-publication-source-paths" className="mb-0 mt-2 max-h-40 list-none overflow-y-auto rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-muted">
            {prepared.sourcePaths.map(path => <li key={path} className="break-all">{path}</li>)}
          </ul>
        </div>
        <div className="space-y-2 text-[13px] text-muted"><h3 className="m-0 text-[13px] font-medium text-ink">Workspace data access</h3>
          {prepared.capabilities.length === 0 ? <p className="m-0">None</p> : prepared.capabilities.map(capability => <div key={capability.collectionPath} data-testid="app-publication-capability" className="space-y-2">
            <p className="m-0">Create records only in <span className="break-all font-mono">{capability.collectionPath}</span>.</p>
            <dl className="m-0 space-y-1 text-[12px]"><div><dt className="inline font-medium text-ink">Fields it can create: </dt><dd className="m-0 inline break-words font-mono">{capability.allowedFields.join(", ")}</dd></div>
              <div><dt className="inline font-medium text-ink">Required fields: </dt><dd className="m-0 inline break-words font-mono">{capability.requiredFields.join(", ") || "None"}</dd></div>
              <div><dt className="inline font-medium text-ink">Fields it can read: </dt><dd className="m-0 inline break-words font-mono">{capability.readFields.join(", ") || "None"}</dd></div></dl>
            <p className="m-0 text-[12px]">The app cannot change or delete existing records.</p>
            <details className="text-[12px]"><summary className="cursor-pointer">Collection schema revision</summary><p className="break-all font-mono">{capability.schemaSha256}</p></details>
          </div>)}
          <p className="m-0">The app can use external services and send them data it receives.</p>
          <p className="m-0">Unpublishing stops new access through dohc. It cannot remove copies sent elsewhere.</p>
        </div>
        <details className="text-[12px] text-muted"><summary className="cursor-pointer">Publication revision</summary>
          <dl className="space-y-2 font-mono"><div><dt>Version</dt><dd className="m-0 break-all">{prepared.versionId}</dd></div>
            <div><dt>Source</dt><dd className="m-0 break-all">{prepared.sourceRevision}</dd></div>
            <div><dt>Publication</dt><dd data-testid="app-publication-digest" className="m-0 break-all">{prepared.candidateDigest}</dd></div></dl>
        </details>
        <footer className="flex justify-end gap-2"><SecondaryButton disabled={!!busy} onClick={back}>Back</SecondaryButton>
          <PrimaryButton data-testid="app-publication-approve" disabled={!!busy} onClick={() => void approve()}>{busy === "approve" ? "Publishing…" : reactivating ? "Republish this revision" : "Publish this revision"}</PrimaryButton></footer>
      </> : <>
        <div className="border-b border-line pb-4">
          <div className="flex items-center justify-between gap-3"><h3 className="m-0 text-[13px] font-medium text-ink">Publications</h3>
            <SecondaryButton disabled={publicationsLoading || !!busy} onClick={() => setPublicationsReload(value => value + 1)}>Reload publications</SecondaryButton></div>
          {publicationsLoading ? <p role="status" className="mb-0 text-[12px] text-muted">Loading publications…</p> : publicationsError ?
            <p role="alert" className="mb-0 text-[13px] text-danger">{publicationsError}</p> : publications.length === 0 ?
              <p className="mb-0 text-[12px] text-muted">No publications.</p> : <ul className="m-0 mt-3 list-none space-y-3 p-0">
                  {publications.map(publication => <li key={publication.publicationId} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[12px] text-muted"><p className="m-0 break-all">Link {publication.grantId.slice(0, 8)} · {publication.active ? "Published" : "Unpublished"}</p>
                    {publication.manifestUnavailable ? <><p className="m-0 text-warning">Source details unavailable. This publication may belong to another app.</p>
                      <p className="m-0 break-all font-mono">{publication.publicationId}</p></> :
                      <p className="m-0 truncate font-mono" title={publication.sourceRevision}>Source {publication.sourceRevision.slice(0, 12)}</p>}</div>
                  {publication.active ? <SecondaryButton disabled={!!busy} aria-label={`Unpublish ${publication.publicationId}`} onClick={() => setPendingWithdraw(publication)}>{busy === "withdraw" && busyPublicationId === publication.publicationId ? "Unpublishing…" : "Unpublish"}</SecondaryButton> :
                    publication.manifestUnavailable ? <span className="text-[12px] text-muted">Source unavailable</span> : <SecondaryButton disabled={!!busy} onClick={() => void reviewReactivation(publication)}>{busy === "prepare" && busyPublicationId === publication.publicationId ? "Loading revision…" : "Review and republish"}</SecondaryButton>}
                </li>)}
              </ul>}
        </div>
        {!publicationsLoading && !publicationsError ? [...new Set(publications.map(publication => publication.grantId))].map(grantId => <div key={grantId}>
          <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">Link {grantId}</p>
          <OwnerAppResponses workspaceId={props.workspaceId} grantId={grantId} />
        </div>) : null}
        <label className="text-[13px] text-ink">Share link
          <select aria-label="Publication share link" disabled={loading || !!busy} value={selected} onChange={event => setSelected(event.target.value)}
            className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink">
            <option value="">Choose a link</option>{links.map(link => <option key={link.grantId} value={link.grantId}>{linkLabel(link)}</option>)}
          </select></label>
        {loading ? <p role="status" className="m-0 text-[13px] text-muted">Loading links…</p> : loadError ? <div><p role="alert" className="text-[13px] text-danger">{loadError}</p><SecondaryButton onClick={() => setReload(value => value + 1)}>Reload links</SecondaryButton></div> : links.length === 0 ?
          <p className="m-0 text-[13px] text-muted">No active links include this app's source folder.</p> : null}
        {props.onShareSource ? <div className="flex items-center justify-between gap-3"><p className="m-0 text-[12px] text-muted">Create a link that includes this app's source files.</p>
          <SecondaryButton disabled={!!busy} onClick={() => { props.onClose(); props.onShareSource?.(); }}>Share app folder</SecondaryButton></div> : null}
        <p className="m-0 text-[13px] text-muted">Prepare the app to review its source and data access before publishing.</p>
        <footer className="flex justify-end gap-2"><SecondaryButton disabled={committing} onClick={props.onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!!busy || !selectedLink || loading || !!loadError} onClick={() => void prepare()}>{busy === "prepare" ? "Preparing app…" : "Prepare app"}</PrimaryButton></footer>
      </>}
      </section></Overlay>
      {pendingWithdraw ? <ConfirmDialog testId="app-publication-withdraw-confirm" cancelTestId="app-publication-withdraw-cancel" confirmTestId="app-publication-withdraw-confirm-action" title="Unpublish this app?" confirmLabel="Unpublish app" onCancel={closeWithdrawal} onConfirm={() => { const value = pendingWithdraw; closeWithdrawal(); void withdraw(value); }}>
        <p className="mt-3 mb-0 text-[13px] text-muted">This stops new access through dohc. It cannot remove copies sent elsewhere.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">{pendingWithdraw.manifestUnavailable ? "Source details are unavailable. This publication may belong to another app and cannot currently be republished." : "You can review this stored revision and publish it again."}</p>
        <p className="mt-2 mb-0 break-all font-mono text-[12px] text-muted">{pendingWithdraw.manifestUnavailable ? pendingWithdraw.publicationId : pendingWithdraw.appRoot}</p>
      </ConfirmDialog> : null}
  </>;
}
