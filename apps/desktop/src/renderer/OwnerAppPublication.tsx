import { useCallback, useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import type { AppBackendCapability, AppBackendOperation } from "@dohc/security-contract/app-backend";
import type { AppDatasetCapability } from "@dohc/security-contract/dataset";
import type { RelayShareLinkRow } from "../ipc/bridgeContract";
import { OwnerAppPublicationResult, type OwnerAppPublicationRequest } from "../ipc/ownerAppPublicationContract";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { OwnerAppBackend, type ReportError } from "./OwnerAppBackend";
import { OwnerAppResponses } from "./OwnerAppResponses";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";

type Prepared = Extract<OwnerAppPublicationResult, { kind: "prepared" }>;
type Publication = Extract<OwnerAppPublicationResult, { kind: "listed" }>["publications"][number];
type LocalPublication = Extract<OwnerAppPublicationResult, { kind: "localListed" }>["publications"][number];
type ActiveLink = RelayShareLinkRow & { selector: NonNullable<RelayShareLinkRow["selector"]> };
const availableBackend = (publication: Publication): AppBackendCapability | null =>
  publication.backendCapability && publication.backendCapability !== "unavailable" ? publication.backendCapability : null;
const names = (operations: AppBackendOperation[], access: AppBackendOperation["access"]) => operations.filter(operation => operation.access === access).map(operation => operation.name).join(", ") || "None";

function BackendSummary({ capability }: { capability: AppBackendCapability | null }) {
  if (!capability) return null;
  return <details className="mt-1"><summary className="cursor-pointer">Approved backend access</summary>
    <p className="mb-0 break-all font-mono">{capability.dataPath}</p>
    <p className="mb-0 break-words">Link: {names(capability.operations, "link")}</p>
    <p className="mb-0 break-words">Helper: {names(capability.operations, "helper")}</p>
    <p className="mb-0 break-words">Owner: {names(capability.operations, "owner")}</p>
    <p className="mb-0 break-words">Tables: {capability.tables.map(table => table.name).join(", ") || "None"}</p>
  </details>;
}

function OperationNames({ operations }: { operations: AppBackendOperation[] }) {
  if (operations.length === 0) return <>None</>;
  return <>{operations.map((operation, index) => <span key={operation.name}>{index ? ", " : ""}<span className="font-mono">{operation.name}</span> ({operation.readOnly ? "reads only" : "changes data"})</span>)}</>;
}

function DatasetApproval({ capability }: { capability: AppDatasetCapability }) {
  return <div data-testid="app-publication-capability" className="space-y-2">
    <p className="m-0">This app uses the Collection's approved actions. Its responses appear in the same Collection.</p>
    <dl className="m-0 space-y-1 text-[12px]">
      <div><dt className="inline font-medium text-ink">Link actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "link")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Helper actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "helper")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Owner actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "owner")} /></dd></div>
    </dl>
    <p className="m-0 text-[12px]">Approving this app grants these actions. It does not change the Collection's rules.</p>
    <details className="text-[12px]"><summary className="cursor-pointer">Collection revision</summary>
      <p className="break-all font-mono">{capability.datasetId} · {capability.revision}</p>
      <p className="break-all font-mono">{capability.revisionSha256}</p>
    </details>
  </div>;
}

function BackendApproval({ capability, local }: { capability: AppBackendCapability; local: boolean }) {
  const group = (access: AppBackendOperation["access"]) => capability.operations.filter(operation => operation.access === access);
  return <div data-testid="app-publication-capability" className="space-y-2">
    <p className="m-0">App data <span className="break-all font-mono">{capability.dataPath}</span> {local ? "stays in a private store on this device" : "lives in a private store on your dohc host"}. It is not a workspace file. This gives the app no access to workspace files.</p>
    {local ? <p className="m-0 text-[12px]">No link exists for this approval. Only you can use the data until you publish the app on a link.</p> : null}
    <dl className="m-0 space-y-1 text-[12px]">
      <div><dt className="inline font-medium text-ink">{local ? "Once published on a link, anyone with the link can run: " : "Anyone with the link can run: "}</dt><dd className="m-0 inline break-words"><OperationNames operations={group("link")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Helpers you allow can also run: </dt><dd className="m-0 inline break-words"><OperationNames operations={group("helper")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Only you can run: </dt><dd className="m-0 inline break-words"><OperationNames operations={group("owner")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Tables you can browse: </dt><dd className="m-0 inline break-words">{capability.tables.length === 0 ? "None" :
        capability.tables.map((table, index) => <span key={table.name}>{index ? ", " : ""}<span className="font-mono">{table.name}</span>{table.writeOperation ? "" : " (read-only)"}</span>)}</dd></div>
    </dl>
    <p className="m-0 text-[12px]">Link holders see only what these operations return. They cannot read the data file.</p>
    <details className="text-[12px]"><summary className="cursor-pointer">Backend revision</summary>
      <dl className="space-y-1 font-mono"><div><dt>Schema version</dt><dd className="m-0">{capability.schemaVersion}</dd></div>
        <div><dt>Backend</dt><dd className="m-0 break-all">{capability.backendSha256}</dd></div>
        <div><dt>Schema</dt><dd className="m-0 break-all">{capability.schemaSha256}</dd></div></dl>
    </details>
  </div>;
}

/** The local launcher answers with a loopback address only. Anything else never reaches the browser. */
function localLaunchUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && url.username === "" && url.password === "" ? url.toString() : null;
}

function verifiedPrepared(result: OwnerAppPublicationResult): Prepared {
  const checked = OwnerAppPublicationResult.safeParse(result);
  if (!checked.success || checked.data.kind !== "prepared") throw new Error("dohc could not verify this app's data access. Prepare the app again.");
  return checked.data;
}

type PublicationProps = { workspaceId: string; appRoot: string; onShareSource?: () => void; reportError?: ReportError };

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

function PublicationDialog(props: PublicationProps & { onClose: () => void }) {
  const [links, setLinks] = useState<ActiveLink[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [preparedLink, setPreparedLink] = useState("");
  const [busy, setBusy] = useState<"prepare" | "approve" | "withdraw" | "revokeCollection" | "launch" | null>(null);
  const [busyPublicationId, setBusyPublicationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [pendingWithdraw, setPendingWithdraw] = useState<Publication | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<Publication | null>(null);
  const [publicationsLoading, setPublicationsLoading] = useState(true);
  const [responseRequests, setResponseRequests] = useState<ReadonlySet<string>>(new Set());
  const responsesBusy = responseRequests.size > 0;
  const responseBusyChanged = useCallback((grantId: string, active: boolean) => {
    setResponseRequests(previous => {
      if (previous.has(grantId) === active) return previous;
      const next = new Set(previous);
      if (active) next.add(grantId); else next.delete(grantId);
      return next;
    });
  }, []);
  const [publicationsError, setPublicationsError] = useState<string | null>(null);
  const [publicationsReload, setPublicationsReload] = useState(0);
  // Local approvals need no host, so they load and fail independently of links and shared publications.
  const [localPublications, setLocalPublications] = useState<LocalPublication[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localReload, setLocalReload] = useState(0);
  const [localPreparing, setLocalPreparing] = useState(false);
  const alive = useRef(true);
  const request = useRef(0);
  const candidate = useRef<Prepared | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const api = useRef(bridge()).current;
  const selectedLink = links.find(link => link.grantId === selected);
  const committing = busy === "approve" || busy === "withdraw" || busy === "revokeCollection" || responsesBusy;
  // Backend data errors go to the shell's Notices when root passes reportShellError; otherwise this dialog's own alert line.
  const reportError: ReportError = props.reportError ?? ((fallback, cause) => setError(ipcErrorMessage(cause, fallback)));

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

  useEffect(() => {
    let current = true;
    setLocalLoading(true); setLocalError(null);
    void (async () => {
      const page = await api.publishOwnerApp({ action: "listLocal", workspaceId: props.workspaceId, appRoot: props.appRoot });
      if (!current) return;
      if (page.kind !== "localListed") throw new Error("dohc could not load the apps approved on this device. Reload them.");
      setLocalPublications(page.publications.filter(row => row.appRoot === props.appRoot));
    })().catch(error => { if (current) setLocalError(ipcErrorMessage(error, "dohc could not load the apps approved on this device. Reload them.")); })
      .finally(() => { if (current) setLocalLoading(false); });
    return () => { current = false; };
  }, [api, props.workspaceId, props.appRoot, localReload]);

  const prepareWith = async (input: Extract<OwnerAppPublicationRequest, { action: "prepare" | "prepareLocal" }>, link: string) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("prepare"); setLocalPreparing(input.action === "prepareLocal"); setError(null); setNotice(null);
    try {
      const result = await api.publishOwnerApp(input);
      if (!alive.current || mine !== request.current) { if (result.kind === "prepared") cancel(result); return; }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot || (result.local === true) !== (input.action === "prepareLocal")) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not prepare this app. Try again.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(false);
      setPreparedLink(link);
    } catch (error) {
      if (alive.current && mine === request.current) { cancel(candidate.current); candidate.current = null; setError(ipcErrorMessage(error, "dohc could not prepare this app. Try again.")); }
    } finally { if (alive.current && mine === request.current) { setBusy(null); setLocalPreparing(false); } }
  };
  const prepare = () => selectedLink ? prepareWith({ action: "prepare", workspaceId: props.workspaceId, appRoot: props.appRoot, shareId: selectedLink.shareId, grantId: selectedLink.grantId }, linkLabel(selectedLink)) : undefined;
  const prepareLocal = () => prepareWith({ action: "prepareLocal", workspaceId: props.workspaceId, appRoot: props.appRoot }, "");

  const reviewReactivation = async (publication: Publication) => {
    if (busy || responsesBusy || publication.manifestUnavailable || publication.active || !publication.linkCurrent) return;
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
    if (busy || responsesBusy || !prepared) return;
    const mine = ++request.current;
    setBusy("approve"); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "approve", workspaceId: props.workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published" || (result.local === true) !== (prepared.local === true)) throw new Error("dohc could not confirm publication. Reload the app publications.");
      candidate.current = null;
      if (prepared.local) setLocalReload(value => value + 1); else setPublicationsReload(value => value + 1);
      setPrepared(null);
      setNotice(prepared.local ? "App approved on this device. It is not published on any link." : reactivating ? "App republished." : "App published on the selected link.");
    } catch (error) {
      if (alive.current && mine === request.current) {
        cancel(prepared);
        candidate.current = null;
        setPrepared(null);
        if (prepared.local) setLocalReload(value => value + 1); else setPublicationsReload(value => value + 1);
        setError(ipcErrorMessage(error, "dohc could not confirm publication. Reload the app publications."));
      }
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };

  const withdraw = async (publication: Publication | LocalPublication, local = false) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("withdraw"); setBusyPublicationId(publication.publicationId); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "withdraw", workspaceId: props.workspaceId, publicationId: publication.publicationId, expectedAuthorityRevision: publication.authorityRevision });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "withdrawn") throw new Error("dohc could not confirm that this publication ended. Try again.");
      if (local) setLocalReload(value => value + 1); else setPublicationsReload(value => value + 1);
      setNotice(local ? "App approval removed. Prepare the app again to restore access." : "App unpublished. The share link still works for its other shared content.");
    } catch (error) { if (alive.current && mine === request.current) { setError(ipcErrorMessage(error, "dohc could not end app access. Try again.")); if (local) setLocalReload(value => value + 1); else setPublicationsReload(value => value + 1); } }
    finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };
  const revokeCollection = async (publication: Publication) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("revokeCollection"); setBusyPublicationId(publication.publicationId); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "revokeCollection", workspaceId: props.workspaceId, publicationId: publication.publicationId, expectedAuthorityRevision: publication.authorityRevision });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "collectionRevoked" || result.publicationId !== publication.publicationId || result.authorityRevision !== publication.authorityRevision + 1) throw new Error("dohc could not confirm collection access was revoked. Reload the publications.");
      setPublicationsReload(value => value + 1);
      setNotice("App collection access revoked. Prepare the app again to review and restore access.");
    } catch (error) { if (alive.current && mine === request.current) { setError(ipcErrorMessage(error, "dohc could not confirm revocation. Reload the publications to check current access.")); setPublicationsReload(value => value + 1); } }
    finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };

  // The launcher serves the approved source through its own broker; this dialog only hands the address to the browser.
  const launch = async (publication: LocalPublication) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("launch"); setBusyPublicationId(publication.publicationId); setError(null); setNotice(null);
    try {
      const result = await api.publishOwnerApp({ action: "launchLocal", workspaceId: props.workspaceId, publicationId: publication.publicationId });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "localLaunched" || result.publicationId !== publication.publicationId) throw new Error("dohc could not confirm which app started. Try again.");
      const url = localLaunchUrl(result.url);
      if (!url) throw new Error("The app address is not on this device. dohc did not open it.");
      await api.openExternalUrl({ url });
      if (!alive.current || mine !== request.current) return;
      setNotice("App opened in your browser.");
    } catch (cause) {
      if (alive.current && mine === request.current) reportError("dohc could not open this app in your browser.", cause, () => void launch(publication));
    } finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };

  const back = () => {
    cancel(candidate.current); candidate.current = null; setPrepared(null); setError(null);
  };
  const closeWithdrawal = () => {
    setPendingWithdraw(null);
    heading.current?.focus();
  };
  const closeRevocation = () => {
    setPendingRevoke(null);
    heading.current?.focus();
  };

  return <><Overlay onClose={committing ? undefined : props.onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="app-publication-title" data-testid="app-publication-dialog"
      className="dohc-elevated flex max-h-[calc(100vh-128px)] w-[min(560px,calc(100vw-32px))] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-panel p-5">
      <header className="flex items-center gap-2">
        <h2 ref={heading} tabIndex={-1} id="app-publication-title" className="m-0 flex-1 text-sm font-semibold text-ink">{prepared?.local ? "Review app for this device" : prepared ? "Review app publication" : "Publish app"}</h2>
        <IconButton aria-label="Close publication" disabled={committing} onClick={props.onClose}><X size={14} aria-hidden /></IconButton>
      </header>
      <p className="m-0 break-all font-mono text-[12px] text-muted">{props.appRoot}</p>
      <p className="m-0 text-[12px] text-muted">Publishing apps currently requires Windows x64.</p>
      {responsesBusy ? <p role="status" className="m-0 text-[13px] text-muted">Updating responses. Wait before closing.</p> : null}
      {notice ? <p role="status" className="m-0 text-[13px] text-ink">{notice}</p> : null}
      {error ? <p role="alert" className="m-0 text-[13px] text-danger">{error}</p> : null}
      {prepared ? <>
        <p className="m-0 text-[13px] text-ink">{prepared.local ? "Approve this captured app for this device. It is not published on any link. Later source edits need a new approval." : reactivating ? "Republish this stored revision. It does not include later source edits." : "Publish this captured app. Later source edits need a new publication."}</p>
        <div className="text-[12px] text-muted"><span className="font-medium text-ink">{prepared.local ? "Where" : "Link"}</span><p className="m-0 break-words">{prepared.local ? "This device only" : preparedLink}</p></div>
        <div><h3 className="m-0 text-[13px] font-medium text-ink">Files included</h3>
          <ul data-testid="app-publication-source-paths" className="mb-0 mt-2 max-h-40 list-none overflow-y-auto rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-muted">
            {prepared.sourcePaths.map(path => <li key={path} className="break-all">{path}</li>)}
          </ul>
        </div>
        <div className="space-y-2 text-[13px] text-muted"><h3 className="m-0 text-[13px] font-medium text-ink">Workspace data access</h3>
          {prepared.capabilities.length === 0 ? <p className="m-0">None</p> : prepared.capabilities.map(capability => capability.kind === "app-backend" ? <BackendApproval key={capability.dataPath} capability={capability} local={prepared.local === true} /> : capability.kind === "dataset" ? <DatasetApproval key={capability.datasetId} capability={capability} /> : <div key={capability.collectionPath} data-testid="app-publication-capability" className="space-y-2">
            <p className="m-0">Create records only in <span className="break-all font-mono">{capability.collectionPath}</span>.</p>
            <dl className="m-0 space-y-1 text-[12px]"><div><dt className="inline font-medium text-ink">Fields it can create: </dt><dd className="m-0 inline break-words font-mono">{capability.allowedFields.join(", ")}</dd></div>
              <div><dt className="inline font-medium text-ink">Required fields: </dt><dd className="m-0 inline break-words font-mono">{capability.requiredFields.join(", ") || "None"}</dd></div>
              <div><dt className="inline font-medium text-ink">Fields shown in the app: </dt><dd className="m-0 inline break-words font-mono">{capability.readFields.join(", ") || "None"}</dd></div></dl>
            <p className="m-0 text-[12px]">People with this share can read every response file and all its fields.</p>
            <p className="m-0 text-[12px]">The app cannot change or delete existing records.</p>
            <details className="text-[12px]"><summary className="cursor-pointer">Collection schema revision</summary><p className="break-all font-mono">{capability.schemaSha256}</p></details>
          </div>)}
          <p className="m-0">The app can use external services and send them data it receives.</p>
          {prepared.local ? null : <p className="m-0">Unpublishing stops new access through dohc. It cannot remove copies sent elsewhere.</p>}
        </div>
        <details className="text-[12px] text-muted"><summary className="cursor-pointer">Publication revision</summary>
          <dl className="space-y-2 font-mono"><div><dt>Version</dt><dd className="m-0 break-all">{prepared.versionId}</dd></div>
            <div><dt>Source</dt><dd className="m-0 break-all">{prepared.sourceRevision}</dd></div>
            <div><dt>Publication</dt><dd data-testid="app-publication-digest" className="m-0 break-all">{prepared.candidateDigest}</dd></div></dl>
        </details>
        <footer className="flex justify-end gap-2"><SecondaryButton disabled={!!busy || responsesBusy} onClick={back}>Back</SecondaryButton>
          <PrimaryButton data-testid="app-publication-approve" disabled={!!busy || responsesBusy} onClick={() => void approve()}>{busy === "approve" ? (prepared.local ? "Approving…" : "Publishing…") : prepared.local ? "Approve for this device" : reactivating ? "Republish this revision" : "Publish this revision"}</PrimaryButton></footer>
      </> : <>
        <div className="border-b border-line pb-4">
          <div className="flex items-center justify-between gap-3"><h3 className="m-0 text-[13px] font-medium text-ink">This device</h3>
            <div className="flex gap-2"><SecondaryButton aria-label="Reload local apps" disabled={localLoading || !!busy || responsesBusy} onClick={() => setLocalReload(value => value + 1)}>Reload</SecondaryButton>
              <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => void prepareLocal()}>{localPreparing ? "Preparing app…" : "Prepare for this device"}</SecondaryButton></div></div>
          <p className="mb-0 mt-1 text-[12px] text-muted">Run this app with its data here. No account or link needed.</p>
          {localLoading ? <p role="status" className="mb-0 text-[12px] text-muted">Loading local apps…</p> : localError ?
            <p role="alert" className="mb-0 text-[13px] text-danger">{localError}</p> : localPublications.length === 0 ?
              <p className="mb-0 mt-2 text-[12px] text-muted">No app approved on this device yet. Prepare it to review its source and data access.</p> : <ul className="m-0 mt-3 list-none space-y-3 p-0">
                {localPublications.map(publication => <li key={publication.publicationId} className="flex items-start justify-between gap-3">
                  <div className="min-w-0 text-[12px] text-muted">
                    <p className="m-0">{publication.active ? "Approved on this device" : "Inactive on this device"} · <span className="font-mono" title={publication.sourceRevision}>Source {publication.sourceRevision.slice(0, 12)}</span></p>
                    {publication.active ? null : <p className="m-0 text-warning">Its data is not active here. If you moved it to a share link, open that publication.</p>}
                    {"datasetCapability" in publication ? <details className="mt-1"><summary className="cursor-pointer">Approved Collection access</summary><DatasetApproval capability={publication.datasetCapability} /></details> : <BackendSummary capability={publication.backendCapability} />}
                  </div>
                  {publication.active ? <div className="flex shrink-0 flex-col gap-2"><SecondaryButton disabled={!!busy || responsesBusy} aria-label={`Open in browser ${publication.publicationId}`} onClick={() => void launch(publication)}>{busy === "launch" && busyPublicationId === publication.publicationId ? "Opening…" : "Open in browser"}</SecondaryButton>
                    {"datasetCapability" in publication ? <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => void withdraw(publication, true)}>Remove approval</SecondaryButton> : null}</div> : null}
                </li>)}
              </ul>}
        </div>
        {localPublications.filter(publication => publication.active).map(publication => <div key={publication.publicationId}>
          <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">This device · Source {publication.sourceRevision.slice(0, 12)}</p>
          {"datasetCapability" in publication ? <p className="text-[12px] text-muted">Open the Collection to view and manage its records.</p> : <OwnerAppBackend workspaceId={props.workspaceId} publicationId={publication.publicationId} capability={publication.backendCapability} local disabled={localLoading || !!busy} onError={reportError} />}
        </div>)}
        <div className="border-b border-line pb-4">
          <div className="flex items-center justify-between gap-3"><h3 className="m-0 text-[13px] font-medium text-ink">Publications</h3>
            <SecondaryButton disabled={publicationsLoading || !!busy || responsesBusy} onClick={() => setPublicationsReload(value => value + 1)}>Reload publications</SecondaryButton></div>
          {publicationsLoading ? <p role="status" className="mb-0 text-[12px] text-muted">Loading publications…</p> : publicationsError ?
            <p role="alert" className="mb-0 text-[13px] text-danger">{publicationsError}</p> : publications.length === 0 ?
              <p className="mb-0 text-[12px] text-muted">No publications.</p> : <ul className="m-0 mt-3 list-none space-y-3 p-0">
                  {publications.map(publication => <li key={publication.publicationId} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[12px] text-muted"><p className="m-0 break-all">Link {publication.grantId.slice(0, 8)} · {!publication.linkCurrent ? "Link changed" : publication.active ? "Published" : "Unpublished"}</p>
                    {!publication.linkCurrent ? <p className="m-0 text-warning">This publication is unavailable. Choose a current link below and review the app again.</p> : null}
                    {publication.manifestUnavailable ? <><p className="m-0 text-warning">Source details unavailable. This publication may belong to another app.</p>
                      <p className="m-0 break-all font-mono">{publication.publicationId}</p></> :
                      <p className="m-0 truncate font-mono" title={publication.sourceRevision}>Source {publication.sourceRevision.slice(0, 12)}</p>}
                    {publication.collectionCapability === "unavailable" ? <p className="mb-0 mt-1 text-warning">Collection access details unavailable. You can still revoke access.</p> : publication.collectionCapability ? <details className="mt-1"><summary className="cursor-pointer">Approved collection access</summary>
                      <p className="mb-0 break-all font-mono">{publication.collectionCapability.collectionPath}</p>
                      <p className="mb-0 break-words">Create: {publication.collectionCapability.allowedFields.join(", ")}</p>
                      <p className="mb-0 break-words">Required: {publication.collectionCapability.requiredFields.join(", ") || "None"}</p>
                      <p className="mb-0 break-words">Shown in the app: {publication.collectionCapability.readFields.join(", ") || "None"}</p>
                      <p className="mb-0">People with this share can read every response file and all its fields.</p>
                    </details> : availableBackend(publication) || publication.datasetCapability ? null : <p className="mb-0 mt-1">No collection access</p>}
                    {publication.datasetCapability === "unavailable" ? <p className="mb-0 mt-1 text-warning">Collection access details unavailable.</p> : publication.datasetCapability ? <details className="mt-1"><summary className="cursor-pointer">Approved Collection access</summary><DatasetApproval capability={publication.datasetCapability} /><p className="mb-0">Open the Collection to view and manage its records.</p></details> : null}
                    {publication.backendCapability === "unavailable" ? <p className="mb-0 mt-1 text-warning">Backend data details unavailable.</p> : <BackendSummary capability={availableBackend(publication)} />}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {publication.collectionCapability ? <SecondaryButton disabled={!!busy || responsesBusy} aria-label={`Revoke collection access ${publication.publicationId}`} onClick={() => setPendingRevoke(publication)}>{busy === "revokeCollection" && busyPublicationId === publication.publicationId ? "Revoking…" : "Revoke collection access"}</SecondaryButton> : null}
                    {publication.active ? <SecondaryButton disabled={!!busy || responsesBusy} aria-label={`Unpublish ${publication.publicationId}`} onClick={() => setPendingWithdraw(publication)}>{busy === "withdraw" && busyPublicationId === publication.publicationId ? "Unpublishing…" : "Unpublish"}</SecondaryButton> :
                      !publication.linkCurrent ? null : publication.manifestUnavailable ? <span className="text-[12px] text-muted">Source unavailable</span> : <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => void reviewReactivation(publication)}>{busy === "prepare" && busyPublicationId === publication.publicationId ? "Loading revision…" : "Review and republish"}</SecondaryButton>}
                  </div>
                </li>)}
              </ul>}
        </div>
        {[...new Set(publications.filter(publication => !publication.manifestUnavailable && publication.appRoot === props.appRoot).map(publication => publication.grantId))].map(grantId => <div key={grantId}>
          <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">Link {grantId}</p>
          <OwnerAppResponses workspaceId={props.workspaceId} grantId={grantId} disabled={publicationsLoading || !!busy} onBusyChange={responseBusyChanged} />
        </div>)}
        {publications.flatMap(publication => {
          const capability = availableBackend(publication);
          return !capability || publication.manifestUnavailable || publication.appRoot !== props.appRoot ? [] : [<div key={publication.publicationId}>
            <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">Publication {publication.publicationId.slice(0, 12)} · Link {publication.grantId}</p>
            <OwnerAppBackend workspaceId={props.workspaceId} publicationId={publication.publicationId} capability={capability} disabled={publicationsLoading || !!busy} onError={reportError} />
          </div>];
        })}
        <div><h3 className="m-0 text-[13px] font-medium text-ink">Publish on a share link</h3>
          <p className="mb-0 mt-1 text-[12px] text-muted">Publishing on a link needs a connection to your dohc host. Approval for this device does not.</p></div>
        <label className="text-[13px] text-ink">Share link
          <select aria-label="Publication share link" disabled={loading || !!busy || responsesBusy} value={selected} onChange={event => setSelected(event.target.value)}
            className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink">
            <option value="">Choose a link</option>{links.map(link => <option key={link.grantId} value={link.grantId}>{linkLabel(link)}</option>)}
          </select></label>
        {loading ? <p role="status" className="m-0 text-[13px] text-muted">Loading links…</p> : loadError ? <div><p role="alert" className="text-[13px] text-danger">{loadError}</p><SecondaryButton onClick={() => setReload(value => value + 1)}>Reload links</SecondaryButton></div> : links.length === 0 ?
          <p className="m-0 text-[13px] text-muted">No active links include this app's source folder.</p> : null}
        {props.onShareSource ? <div className="flex items-center justify-between gap-3"><p className="m-0 text-[12px] text-muted">Create a link that includes this app's source files.</p>
          <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => { props.onClose(); props.onShareSource?.(); }}>Share app folder</SecondaryButton></div> : null}
        <p className="m-0 text-[13px] text-muted">Prepare the app to review its source and data access before publishing.</p>
        <footer className="flex justify-end gap-2"><SecondaryButton disabled={committing} onClick={props.onClose}>Cancel</SecondaryButton>
          <PrimaryButton disabled={!!busy || responsesBusy || !selectedLink || loading || !!loadError} onClick={() => void prepare()}>{busy === "prepare" && !localPreparing ? "Preparing app…" : "Prepare app"}</PrimaryButton></footer>
      </>}
      </section></Overlay>
      {pendingRevoke ? <ConfirmDialog testId="app-collection-revoke-confirm" cancelTestId="app-collection-revoke-cancel" confirmTestId="app-collection-revoke-action" title="Revoke collection access?" confirmLabel="Revoke access" onCancel={closeRevocation} onConfirm={() => { const value = pendingRevoke; closeRevocation(); void revokeCollection(value); }}>
        <p className="mt-3 mb-0 text-[13px] text-muted">The app stays published. It can no longer read the collection or accept responses through dohc.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">Saved responses stay in your workspace. Copies already received cannot be removed.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">Prepare the app again to review and restore access.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">To reduce access, revoke it first. Change the app's data request, then prepare and review a new publication.</p>
        {pendingRevoke.manifestUnavailable ? <p className="mt-2 mb-0 text-[13px] text-warning">Source details are unavailable. This publication may belong to another app.</p> : null}
        <p className="mt-2 mb-0 break-all font-mono text-[12px] text-muted">{pendingRevoke.publicationId}</p>
      </ConfirmDialog> : null}
      {pendingWithdraw ? <ConfirmDialog testId="app-publication-withdraw-confirm" cancelTestId="app-publication-withdraw-cancel" confirmTestId="app-publication-withdraw-confirm-action" title="Unpublish this app?" confirmLabel="Unpublish app" onCancel={closeWithdrawal} onConfirm={() => { const value = pendingWithdraw; closeWithdrawal(); void withdraw(value); }}>
        <p className="mt-3 mb-0 text-[13px] text-muted">This stops new access through dohc. It cannot remove copies sent elsewhere.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">{!pendingWithdraw.linkCurrent ? "This publication belongs to a changed link. Choose a current link to publish the app again." : pendingWithdraw.manifestUnavailable ? "Source details are unavailable. This publication may belong to another app and cannot currently be republished." : "You can review this stored revision and publish it again."}</p>
        <p className="mt-2 mb-0 break-all font-mono text-[12px] text-muted">{pendingWithdraw.manifestUnavailable ? pendingWithdraw.publicationId : pendingWithdraw.appRoot}</p>
      </ConfirmDialog> : null}
  </>;
}
