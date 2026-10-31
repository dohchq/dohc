import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { AppWindow, ChevronDown, ChevronRight, CircleCheck, CircleDashed, Eye, Globe, Link as LinkIcon, Pencil, Table2, TriangleAlert, X, type LucideIcon } from "lucide-react";
import type { AppDatasetCapability } from "@dohc/security-contract/dataset";
import type { AppCollectionCapability } from "@dohc/security-contract/app-publication";
import type { RelayShareLinkRow } from "../ipc/bridgeContract";
import { OwnerAppPublicationResult, type OwnerAppPublicationRequest } from "../ipc/ownerAppPublicationContract";
import { bridge } from "./bridge";
import { CollectionMoveNote, type CollectionServer } from "./collections/CollectionMoveNote";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { OwnerAppResponses } from "./OwnerAppResponses";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { IconButton, Pill, PrimaryButton, RetryRow, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";

type Prepared = Extract<OwnerAppPublicationResult, { kind: "prepared" }>;
const collectionKey = (approvalId: string, datasetId: string) => `${approvalId}\0${datasetId}`;
type Publication = Extract<OwnerAppPublicationResult, { kind: "listed" }>["publications"][number];
type LocalPublication = Extract<OwnerAppPublicationResult, { kind: "localListed" }>["publications"][number];
type ActiveLink = RelayShareLinkRow & { selector: NonNullable<RelayShareLinkRow["selector"]> };
type ReportError = (fallback: string, error: unknown, retry: (() => void) | null) => void;

function OperationNames({ operations }: { operations: AppDatasetCapability["operations"] }) {
  if (operations.length === 0) return <>None</>;
  return <>{operations.map((operation, index) => <span key={operation.name}>{index ? ", " : ""}<span className="font-mono">{operation.name}</span> ({operation.readOnly ? "reads only" : "changes data"})</span>)}</>;
}

/**
 * `moves`: publishing moves a Collection on this computer to the workspace's server.
 * `onPlace` hears where to: a server, null when nothing moves, or undefined until dohc knows.
 */
function DatasetApproval({ capability, workspaceId, reportError, moves = false, onPlace }: { capability: AppDatasetCapability; workspaceId: string; reportError: ReportError; moves?: boolean; onPlace?(server: CollectionServer | null | undefined): void }) {
  const [address, setAddress] = useState<{ workspaceId: string; datasetId: string; path: string | null; status: "missing" | "ambiguous" | "failed" | "available" } | null>(null);
  const [reload, setReload] = useState(0);
  const report = useRef(reportError);
  report.current = reportError;
  const placed = useRef(onPlace);
  placed.current = onPlace;
  useEffect(() => {
    let current = true, failure = "dohc could not find this Collection.";
    setAddress(null);
    placed.current?.(undefined);
    void (async () => {
      let after: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await bridge().dataset({ action: "list", workspaceId, after, includeArchived: true });
        if (!current) return;
        if (page.kind !== "list") throw Error("dohc could not find this Collection.");
        const dataset = page.datasets.find(value => value.datasetId === capability.datasetId);
        if (dataset) {
          failure = "dohc could not check where this Collection is.";
          const access = moves && dataset.datasetPath
            ? await bridge().dataset({ action: "permissions", workspaceId, datasetPath: dataset.datasetPath, expectedDatasetId: capability.datasetId, limit: 1 }) : null;
          if (!current) return;
          const place = access?.kind === "permissions" ? access.place : undefined;
          setAddress({ workspaceId, datasetId: capability.datasetId, path: dataset.datasetPath, status: dataset.datasetAddressStatus ?? (dataset.datasetPath ? "available" : "missing") });
          placed.current?.(!moves ? null : place === undefined ? undefined : place.kind === "here" ? place.server : null);
          return;
        }
        after = page.nextCursor ?? undefined;
        if (after && seen.has(after)) throw Error("The Collection list changed. Try again.");
        if (after) seen.add(after);
      } while (after);
      if (!current) return;
      setAddress({ workspaceId, datasetId: capability.datasetId, path: null, status: "missing" });
      placed.current?.(moves ? undefined : null);
    })().catch(error => {
      if (!current) return;
      setAddress({ workspaceId, datasetId: capability.datasetId, path: null, status: "failed" });
      report.current(failure, error, () => { if (current) setReload(value => value + 1); });
    });
    return () => { current = false; };
  }, [workspaceId, capability.datasetId, moves, reload]);
  const found = address?.workspaceId === workspaceId && address.datasetId === capability.datasetId ? address : null;
  return <div data-testid="app-publication-capability" className="space-y-2">
    <p className="m-0 font-medium">{capability.name}</p>
    <p className="m-0 break-all font-mono text-[12px]">{!found ? "Finding Collection…" : found.path ?? (found.status === "ambiguous" ? "Multiple dataset.json files name this Collection. Remove the duplicate file." : found.status === "missing" ? "Collection source missing. Restore its dataset.json file." : "Collection path unavailable")}</p>
    <p className="m-0">This app uses the Collection's approved actions. Its responses appear in the same Collection.</p>
    <dl className="m-0 space-y-1 text-[12px]">
      <div><dt className="inline font-medium text-ink">Link actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "link" || capability.linkReads?.some(read => read.operationId === operation.operationId))} /></dd></div>
      <div><dt className="inline font-medium text-ink">Helper actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "helper")} /></dd></div>
      <div><dt className="inline font-medium text-ink">Owner actions: </dt><dd className="m-0 inline"><OperationNames operations={capability.operations.filter(operation => operation.access === "owner")} /></dd></div>
    </dl>
    {capability.linkReads?.length ? <p className="m-0 text-[12px]">Approved link reads: {capability.operations.filter(operation => capability.linkReads!.some(read => read.operationId === operation.operationId)).map(operation => `${operation.name} (${operation.fields?.map(field => field.name).join(", ")})`).join("; ")}. Unpublish to withdraw access.</p> : null}
    <p className="m-0 text-[12px]">Approving this app grants these actions. It does not change the Collection's rules.</p>
    <details className="text-[12px]"><summary className="cursor-pointer">Collection revision</summary>
      <p className="break-all font-mono">Revision {capability.revision}</p>
      <p className="break-all font-mono">{capability.revisionSha256}</p>
    </details>
  </div>;
}

const responses = (count: number) => `${count} ${count === 1 ? "response" : "responses"}`;
const unconfirmedResponses = (count: number) => `${responses(count)} not yet confirmed`;
const unconfirmedRemoval = (count: number) => `dohc removed this app's approval but has not confirmed whether ${responses(count)} ${count === 1 ? "was" : "were"} saved.`;

function CollectionApproval({ capability }: { capability: AppCollectionCapability }) {
  return <div data-testid="app-publication-capability" className="space-y-2">
    <p className="m-0">Create records only in <span className="break-all font-mono">{capability.collectionPath}</span>.</p>
    <dl className="m-0 space-y-1 text-[12px]"><div><dt className="inline font-medium text-ink">Fields it can create: </dt><dd className="m-0 inline break-words font-mono">{capability.allowedFields.join(", ")}</dd></div>
      <div><dt className="inline font-medium text-ink">Required fields: </dt><dd className="m-0 inline break-words font-mono">{capability.requiredFields.join(", ") || "None"}</dd></div>
      <div><dt className="inline font-medium text-ink">Fields shown in the app: </dt><dd className="m-0 inline break-words font-mono">{capability.readFields.join(", ") || "None"}</dd></div></dl>
    <p className="m-0 text-[12px]">People with this share can read every response file and all its fields.</p>
    <p className="m-0 text-[12px]">The app cannot change or delete existing records.</p>
    <details className="text-[12px]"><summary className="cursor-pointer">Collection schema revision</summary><p className="break-all font-mono">{capability.schemaSha256}</p></details>
  </div>;
}

/** The local launcher answers with a loopback address only. Anything else never reaches the browser. */
export function localLaunchUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== "" && url.username === "" && url.password === "" ? url.toString() : null;
}

/** Starts an approved app on this device and hands its loopback address to the browser. False when the caller went stale first. */
export async function openLocalApp(api: ReturnType<typeof bridge>, workspaceId: string, publicationId: string, current: () => boolean): Promise<boolean> {
  const result = await api.publishOwnerApp({ action: "launchLocal", workspaceId, publicationId });
  if (!current()) return false;
  if (result.kind !== "localLaunched" || result.publicationId !== publicationId) throw new Error("dohc could not confirm which app started. Try again.");
  const url = localLaunchUrl(result.url);
  if (!url) throw new Error("The app address is not on this device. dohc did not open it.");
  await api.openExternalUrl({ url });
  return current();
}

function verifiedPrepared(result: OwnerAppPublicationResult): Prepared {
  const checked = OwnerAppPublicationResult.safeParse(result);
  if (!checked.success || checked.data.kind !== "prepared") throw new Error("dohc could not verify this app's data access. Prepare the app again.");
  return checked.data;
}

type Capability = AppDatasetCapability | AppCollectionCapability;
type Checked = Extract<OwnerAppPublicationResult, { kind: "localChecked" }>;
const checkFailed = "dohc could not check whether this app is approved on this device.";

/** What a capability lets the app do, each item marked when the approval did not already allow it. */
type Reach = { text: string; added: boolean };
type Access = { key: string; name: string; path?: string; reads: Reach[]; changes: Reach[]; adds: boolean };

const approvedCapability = (row: LocalPublication): Capability => "datasetCapability" in row ? row.datasetCapability : row.collectionCapability;

/** `approved` is the capability the person approved earlier, or null on a first review, which marks nothing new. */
function accessOf(capability: Capability, approved: Capability | null): Access {
  if (capability.kind === "dataset") {
    const same = approved?.kind === "dataset" && approved.datasetId === capability.datasetId ? approved : null;
    const item = (operation: AppDatasetCapability["operations"][number]) => ({ text: operation.name, added: approved !== null && !same?.operationIds.includes(operation.operationId) });
    return { key: capability.datasetId, name: capability.name, adds: false,
      reads: capability.operations.filter(operation => operation.readOnly).map(item), changes: capability.operations.filter(operation => !operation.readOnly).map(item) };
  }
  const same = approved && approved.kind !== "dataset" && approved.collectionPath === capability.collectionPath ? approved : null;
  const item = (fields: readonly string[] | undefined) => (field: string) => ({ text: field, added: approved !== null && !fields?.includes(field) });
  return { key: capability.collectionPath, name: capability.collectionPath.split("/").pop() || capability.collectionPath, path: capability.collectionPath, adds: true,
    reads: capability.readFields.map(item(same?.readFields)), changes: capability.allowedFields.map(item(same?.allowedFields)) };
}

function Reaches({ items, prefix }: { items: Reach[]; prefix?: string }) {
  return <dd className="m-0 min-w-0 break-words text-ink">{prefix}{items.map((item, index) => <span key={item.text}>{index ? ", " : ""}{item.text}
    {item.added ? <span className="ml-1 inline-block"><Pill tone="warning">New</Pill></span> : null}</span>)}</dd>;
}

function AccessRows({ access }: { access: Access }) {
  return <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-x-2 px-3">
    <Table2 size={14} aria-hidden className="text-muted" />
    <span className="truncate text-[13px] font-medium text-ink" title={access.path}>{access.name}</span>
    <dl className="col-start-2 m-0 mt-2 grid grid-cols-[88px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[13px]">
      {access.reads.length ? <><dt className="flex items-center gap-2 text-muted"><Eye size={12} aria-hidden />Reads</dt><Reaches items={access.reads} /></> : null}
      {access.changes.length ? <><dt className="flex items-center gap-2 text-muted"><Pencil size={12} aria-hidden />Changes</dt>
        <Reaches items={access.changes} prefix={access.adds ? "Adds records with " : undefined} /></> : null}
    </dl>
  </div>;
}

/** What the app can reach: the approved capabilities, or the candidate's with what the approval lacks marked New. */
function AccessBox({ capabilities, approved, failed, onRetry }: { capabilities: readonly Capability[] | null; approved: Capability | null; failed: boolean; onRetry(): void }) {
  const id = useId();
  return <section aria-labelledby={id}>
    <h3 id={id} className="m-0 mb-2 text-[13px] font-medium text-ink">What it can reach</h3>
    <div data-testid="app-access" className="rounded-lg border border-line bg-bg">
      {capabilities ? <>
        <div className="flex flex-col gap-3 py-3">{capabilities.map(capability => { const access = accessOf(capability, approved); return <AccessRows key={access.key} access={access} />; })}</div>
        <p className="m-0 flex items-start gap-2 border-t border-line px-3 py-2 text-[12px] text-muted"><Globe size={12} aria-hidden className="mt-0.5 shrink-0" />It can send what it receives to other websites.</p>
      </> : failed ? <RetryRow testId="app-access-retry" onRetry={onRetry} /> : <SkeletonRows rows={3} label="Loading what this app can reach…" className="p-3" />}
    </div>
  </section>;
}

function StateLine({ icon: Icon, tone, text, children }: { icon: LucideIcon; tone: string; text: string; children?: ReactNode }) {
  return <div data-testid="app-review-state" className="flex items-start gap-2 text-[13px] text-ink">
    <Icon size={16} aria-hidden className={`mt-0.5 shrink-0 ${tone}`} />
    <div className="min-w-0"><p className="m-0">{text}</p>{children}</div>
  </div>;
}
const More = ({ children }: { children: ReactNode }) => <p className="m-0 mt-1 text-[12px] text-muted">{children}</p>;

// onLocalChange runs after anything that may change this device's approvals, so other views read them again.
// localApproval says how an app approved here opens: in its tab, in the browser, or not at all when it has no app.publish.json.
type PublicationProps = { workspaceId: string; appRoot: string; title?: string; localApproval?: "tab" | "browser" | null;
  onShareSource?: () => void; reportError?: ReportError; onLocalChange?: () => void };

type ControlProps = PublicationProps & { open: boolean; onOpenChange: (open: boolean) => void; testId: string };

/** Review app: the person's one way to see what the app can reach, and to approve or publish it. */
export function OwnerAppPublication(props: ControlProps) {
  return <PublicationControl key={`${props.workspaceId}\0${props.appRoot}`} {...props} />;
}

function PublicationControl(props: ControlProps) {
  return <>
    <SecondaryButton size="compact" data-testid={props.testId} onClick={() => props.onOpenChange(true)}>Review app</SecondaryButton>
    {props.open ? <PublicationDialog {...props} onClose={() => props.onOpenChange(false)} onReopen={() => props.onOpenChange(true)} /> : null}
  </>;
}

function linkLabel(link: ActiveLink) {
  const paths = link.selector.paths.join(", ") || "Workspace";
  const version = link.selector.versionId ? ` · Version ${link.selector.versionId}` : "";
  return `${paths}${version} · ${link.access} · ${link.grantId.slice(0, 8)}`;
}

type LocalReview = { status: "loading" } | { status: "failed" } | { status: "ready"; rows: LocalPublication[]; approval: LocalPublication | null; source: Checked | null };

function PublicationDialog(props: PublicationProps & { onClose: () => void; onReopen: () => void }) {
  const [view, setView] = useState<"local" | "links">(props.localApproval ? "local" : "links");
  const [links, setLinks] = useState<ActiveLink[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [reactivating, setReactivating] = useState(false);
  const [linkReads, setLinkReads] = useState<NonNullable<AppDatasetCapability["linkReads"]>>([]);
  const [preparedLink, setPreparedLink] = useState("");
  const [busy, setBusy] = useState<"prepare" | "approve" | "withdraw" | "revokeCollection" | null>(null);
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
  // Where Publish moves each of a preparation's Collections, once dohc knows, so the review says it before Publish can run.
  const [collectionPlaces, setCollectionPlaces] = useState<ReadonlyMap<string, CollectionServer | null>>(new Map());
  const collectionPlaced = useCallback((key: string, server: CollectionServer | null | undefined) => setCollectionPlaces(previous => {
    if (server === undefined ? !previous.has(key) : previous.get(key) === server) return previous;
    const next = new Map(previous);
    if (server === undefined) next.delete(key); else next.set(key, server);
    return next;
  }), []);
  const collectionKeys = prepared
    ? prepared.capabilities.flatMap(capability => capability.kind === "dataset" ? [collectionKey(prepared.approvalId, capability.datasetId)] : []) : [];
  const collectionsUnchecked = collectionKeys.some(key => !collectionPlaces.has(key));
  const collectionMoves = collectionKeys.flatMap(key => { const server = collectionPlaces.get(key); return server ? [{ key, server }] : []; });
  const [publicationsError, setPublicationsError] = useState<string | null>(null);
  const [publicationsReload, setPublicationsReload] = useState(0);
  // Local approvals need no host, so they load and fail independently of links and shared publications.
  const [localReview, setLocalReview] = useState<LocalReview>({ status: "loading" });
  const [localReload, setLocalReload] = useState(0);
  // The candidate the person approves here. It stays on screen while a replacement prepares.
  const [localCandidate, setLocalCandidate] = useState<Prepared | null>(null);
  const [candidateState, setCandidateState] = useState<"idle" | "loading" | "failed">("idle");
  const [approveFailed, setApproveFailed] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  // Links and publications need this workspace synced; approval for this device does not. A failed check counts as
  // synced, so the link loaders still report their own errors.
  const [synced, setSynced] = useState<boolean | null>(null);
  const alive = useRef(true);
  const request = useRef(0);
  const preparing = useRef(0);
  const candidate = useRef<Prepared | null>(null);
  const localCandidateRef = useRef<Prepared | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const filesId = useId();
  const api = useRef(bridge()).current;
  const selectedLink = links.find(link => link.grantId === selected);
  const committing = busy === "approve" || busy === "withdraw" || busy === "revokeCollection" || responsesBusy;
  // Backend data errors go to the shell's Notices when root passes reportShellError; otherwise this dialog's own alert line.
  const reportError: ReportError = props.reportError ?? ((fallback, cause) => setError(ipcErrorMessage(cause, fallback)));
  const report = useRef(reportError);
  report.current = reportError;
  const localChanged = () => { setLocalReload(value => value + 1); props.onLocalChange?.(); };
  const title = props.title || props.appRoot.split("/").pop() || props.appRoot;

  useEffect(() => { (prepared ? reviewHeading.current : heading.current)?.focus(); }, [prepared, view]);

  const cancel = (value: Prepared | null) => {
    if (value) void api.publishOwnerApp({ action: "cancel", workspaceId: props.workspaceId, approvalId: value.approvalId }).catch(() => undefined);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
      cancel(candidate.current);
      cancel(localCandidateRef.current);
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
    void (async () => {
      const status = await api.cloudStatus({ workspaceId: props.workspaceId });
      if (current) setSynced(status.workspaceSynced !== false);
    })().catch(() => { if (current) setSynced(true); });
    return () => { current = false; };
  }, [api, props.workspaceId]);

  // The approval here, then whether the source still matches it. Neither compiles the app.
  useEffect(() => {
    if (!props.localApproval) return;
    let current = true;
    setLocalReview({ status: "loading" });
    setCandidateState(value => value === "failed" ? "idle" : value);
    void (async () => {
      const page = await api.publishOwnerApp({ action: "listLocal", workspaceId: props.workspaceId, appRoot: props.appRoot });
      if (!current) return;
      if (page.kind !== "localListed") throw new Error(checkFailed);
      const rows = page.publications.filter(row => row.appRoot === props.appRoot);
      const approval = rows.find(row => row.approved) ?? null;
      const source = approval ? await api.publishOwnerApp({ action: "checkLocal", workspaceId: props.workspaceId, appRoot: props.appRoot }) : null;
      if (!current) return;
      if (source && (source.kind !== "localChecked" || source.appRoot !== props.appRoot)) throw new Error(checkFailed);
      setLocalReview({ status: "ready", rows, approval, source: source?.kind === "localChecked" ? source : null });
    })().catch(error => {
      if (!current) return;
      setLocalReview({ status: "failed" });
      report.current(checkFailed, error, () => { if (alive.current) setLocalReload(value => value + 1); else props.onReopen(); });
    });
    return () => { current = false; };
  }, [api, props.workspaceId, props.appRoot, props.localApproval, localReload]);

  const review = localReview.status === "ready" ? localReview : null;
  const approval = review?.approval ?? null;
  const changed = !!approval && !!review?.source && review.source.sourceRevision !== approval.sourceRevision;
  const needsCandidate = !!review && (!approval || changed);

  // A first review or changed source shows the exact candidate, so approval binds what the person read.
  const prepareLocalCandidate = async () => {
    const mine = ++request.current;
    preparing.current = mine;
    setCandidateState("loading");
    try {
      const result = await api.publishOwnerApp({ action: "prepareLocal", workspaceId: props.workspaceId, appRoot: props.appRoot });
      const fresh = alive.current && mine === request.current;
      if (!fresh || result.kind !== "prepared" || result.appRoot !== props.appRoot || result.local !== true) {
        if (result.kind === "prepared") cancel(result);
        if (!fresh) return;
        throw new Error("dohc could not prepare this app. Try again.");
      }
      let verified: Prepared;
      try { verified = verifiedPrepared(result); } catch (cause) { cancel(result); throw cause; }
      cancel(localCandidateRef.current);
      localCandidateRef.current = verified;
      setLocalCandidate(verified);
      setCandidateState("idle");
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      cancel(localCandidateRef.current); localCandidateRef.current = null; setLocalCandidate(null);
      setCandidateState("failed");
      // After the dialog closes, Try again reopens it so the owner can prepare the app again.
      reportError("dohc could not prepare this app.", new Error(ipcErrorMessage(cause, "")), () => { if (alive.current) void prepareLocalCandidate(); else props.onReopen(); });
    } finally {
      // Another action took over, so a later render prepares again if the review still needs it.
      if (alive.current && mine !== request.current && preparing.current === mine) setCandidateState("idle");
    }
  };
  useEffect(() => {
    if (view === "local" && needsCandidate && !localCandidate && candidateState === "idle" && !busy) void prepareLocalCandidate();
  });

  const openApproved = async (publicationId: string) => {
    try { await openLocalApp(api, props.workspaceId, publicationId, () => alive.current); }
    catch (cause) { reportError("dohc could not open this app in your browser.", cause, () => { if (alive.current) void openApproved(publicationId); else props.onReopen(); }); }
  };

  const approveLocal = async () => {
    const value = localCandidate;
    if (!value || busy || responsesBusy || candidateState !== "idle") return;
    const mine = ++request.current;
    setBusy("approve"); setApproveFailed(null); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "approve", workspaceId: props.workspaceId, approvalId: value.approvalId, candidateDigest: value.candidateDigest });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published" || result.local !== true) throw new Error("dohc could not confirm this approval.");
      localCandidateRef.current = null; setLocalCandidate(null);
      localChanged();
      // An app in a tab reopens there on its own once approved.
      if (props.localApproval === "browser") await openApproved(result.publicationId);
      if (alive.current && mine === request.current) props.onClose();
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      // Every attempt spends its candidate, so Try again approves a new one. The old one stays on screen until it arrives.
      localCandidateRef.current = null;
      setApproveFailed(ipcErrorMessage(cause, "dohc could not approve this app."));
      setBusy(null);
      void prepareLocalCandidate();
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };

  const prepareWith = async (input: Extract<OwnerAppPublicationRequest, { action: "prepare" }>, link: string) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("prepare"); setError(null); setNotice(null);
    try {
      const result = await api.publishOwnerApp(input);
      if (!alive.current || mine !== request.current) { if (result.kind === "prepared") cancel(result); return; }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot || result.local === true) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not prepare this app. Try again.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(false);
      setLinkReads([]);
      setPreparedLink(link);
    } catch (cause) {
      if (alive.current && mine === request.current) {
        cancel(candidate.current); candidate.current = null;
        // After the dialog closes, Try again reopens it so the owner can prepare the app again.
        reportError("dohc could not prepare this app.", new Error(ipcErrorMessage(cause, "")), () => { if (alive.current) void prepareWith(input, link); else props.onReopen(); });
      }
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };
  const prepare = () => selectedLink ? prepareWith({ action: "prepare", workspaceId: props.workspaceId, appRoot: props.appRoot, shareId: selectedLink.shareId, grantId: selectedLink.grantId }, linkLabel(selectedLink)) : undefined;

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
    } catch (cause) {
      if (alive.current && mine === request.current) { cancel(candidate.current); candidate.current = null; setError(ipcErrorMessage(cause, "dohc could not load this publication. Reload the publications.")); setPublicationsReload(value => value + 1); }
    } finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
  };

  const approve = async () => {
    if (busy || responsesBusy || !prepared) return;
    const mine = ++request.current;
    setBusy("approve"); setError(null);
    try {
      const result = await api.publishOwnerApp({ action: "approve", workspaceId: props.workspaceId, approvalId: prepared.approvalId, candidateDigest: prepared.candidateDigest, ...(!reactivating && prepared.capabilities.some(value => value.kind === "dataset") ? { linkReads } : {}) });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published" || result.local === true) throw new Error("dohc could not confirm publication. Reload the app publications.");
      candidate.current = null;
      // Publishing a Collection app on a link moves its data off this device, which ends any approval here.
      localChanged(); setPublicationsReload(value => value + 1);
      setPrepared(null);
      setNotice(reactivating ? "App republished." : "App published on the selected link.");
    } catch (cause) {
      if (alive.current && mine === request.current) {
        cancel(prepared);
        candidate.current = null;
        setPrepared(null);
        localChanged(); setPublicationsReload(value => value + 1);
        setError(ipcErrorMessage(cause, "dohc could not confirm publication. Reload the app publications."));
      }
    } finally { if (alive.current && mine === request.current) setBusy(null); }
  };

  const withdraw = async (publication: Publication | LocalPublication, local = false) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("withdraw"); setBusyPublicationId(publication.publicationId); setError(null); setApproveFailed(null);
    try {
      const result = await api.publishOwnerApp({ action: "withdraw", workspaceId: props.workspaceId, publicationId: publication.publicationId, expectedAuthorityRevision: publication.authorityRevision });
      if (!alive.current || mine !== request.current) return;
      if (local && result.kind === "withdrawalUnconfirmed" && result.publicationId === publication.publicationId) {
        // Access ended. Trying again at the ending revision confirms responses the app sent before it.
        localChanged();
        reportError(unconfirmedRemoval(result.unresolvedCreates), undefined,
          () => { if (alive.current) void withdraw({ ...publication, authorityRevision: result.authorityRevision }, true); });
        return;
      }
      if (result.kind !== "withdrawn") throw new Error("dohc could not confirm that this publication ended. Try again.");
      // The review shows the removed approval itself, so only a link says what changed.
      if (local) localChanged(); else { setPublicationsReload(value => value + 1); setNotice("App unpublished. The share link still works for its other shared content."); }
    } catch (cause) { if (alive.current && mine === request.current) { setError(ipcErrorMessage(cause, "dohc could not end app access. Try again.")); if (local) localChanged(); else setPublicationsReload(value => value + 1); } }
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
    } catch (cause) { if (alive.current && mine === request.current) { setError(ipcErrorMessage(cause, "dohc could not confirm revocation. Reload the publications to check current access.")); setPublicationsReload(value => value + 1); } }
    finally { if (alive.current && mine === request.current) { setBusy(null); setBusyPublicationId(null); } }
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

  const localView = view === "local" && !prepared;
  const paths = localView ? review?.source?.sourcePaths ?? (needsCandidate ? localCandidate?.sourcePaths : undefined) : undefined;
  const shown = (path: string) => path.startsWith(`${props.appRoot}/`) ? path.slice(props.appRoot.length + 1) : path;
  const boxCapabilities = !review ? null : !needsCandidate && approval ? [approvedCapability(approval)] : localCandidate?.capabilities ?? null;
  const approving = busy === "approve" || candidateState === "loading";
  const canApprove = !!localCandidate && candidateState === "idle" && !busy && !responsesBusy;
  // A link publication here moves a Collection app's data off this device, so its links show even after that ends the approval.
  const linkRows = publications.filter(publication => publication.active || publication.operatorTakedown);
  const showLinks = !!review && synced === true && !publicationsLoading && !publicationsError && (!!approval || publications.length > 0);
  const status = <>
    {responsesBusy ? <p role="status" className="m-0 text-[13px] text-muted">Updating responses. Wait before closing.</p> : null}
    {notice ? <p role="status" className="m-0 text-[13px] text-ink">{notice}</p> : null}
    {error ? <p role="alert" className="m-0 text-[13px] text-danger">{error}</p> : null}
  </>;

  return <><Overlay onClose={committing ? undefined : props.onClose}>
    <section role="dialog" aria-modal="true" aria-labelledby="app-publication-title" data-testid="app-publication-dialog"
      className="dohc-elevated flex max-h-[calc(100vh-128px)] w-[min(520px,calc(100vw-32px))] flex-col gap-4 overflow-y-auto rounded-xl border border-line bg-panel p-5 text-left">
      {/* The title, then Close, then the files toggle, so Tab follows the header the way it reads. */}
      <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
        <span className="row-span-2 grid size-9 place-items-center rounded-lg bg-panel-2 text-muted"><AppWindow size={18} aria-hidden /></span>
        <h2 ref={heading} tabIndex={-1} id="app-publication-title" className="m-0 truncate text-base font-semibold text-ink" title={title}>{title}</h2>
        <IconButton aria-label="Close publication" disabled={committing} onClick={props.onClose}><X size={14} aria-hidden /></IconButton>
        <div className="col-span-2 col-start-2 mt-1 flex min-w-0 items-center gap-2 text-[12px] text-muted">
          <span className="min-w-0 truncate" title={props.appRoot}>{props.appRoot.split("/").pop() || props.appRoot}</span>
          {paths ? <><span aria-hidden>·</span>
            <button type="button" aria-expanded={filesOpen} aria-controls={filesId} onClick={() => setFilesOpen(value => !value)}
              className="inline-flex shrink-0 items-center gap-1 rounded text-muted hover:text-ink">
              {paths.length === 1 ? "1 file" : `${paths.length} files`}{filesOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button></> : null}
        </div>
        {paths && filesOpen ? <ul id={filesId} data-testid="app-publication-source-paths" className="col-span-2 col-start-2 m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[12px] text-muted">
          {paths.map(path => <li key={path} className="truncate" title={path}>{shown(path)}</li>)}
        </ul> : null}
      </header>
      {localView ? <>
        {!review ? <div aria-hidden className="invisible text-[13px]"><p className="m-0">.</p></div> : approval && !changed ? <StateLine icon={CircleCheck} tone="text-success" text="Approved on this device">
          {approval.active ? null : <More>Inactive on this device</More>}
        </StateLine> : approval ? <StateLine icon={TriangleAlert} tone="text-warning" text="Its source changed since you approved it.">
          <More>The app runs the approved version until you approve the changes.</More>
        </StateLine> : <StateLine icon={CircleDashed} tone="text-muted" text="Approve it to run this version on this device.">
          <More>Later edits to its source wait for your approval.</More>
        </StateLine>}
        {review?.rows.filter(row => !row.approved).map(row => "pendingCreates" in row ? row.pendingCreates > 0 ? <div key={row.publicationId} className="flex items-center gap-2 text-[12px] text-warning">
          <p className="m-0 flex-1">{unconfirmedResponses(row.pendingCreates)}</p>
          <SecondaryButton size="row" disabled={!!busy || responsesBusy} onClick={() => void withdraw(row, true)}>Try again</SecondaryButton>
        </div> : null : <p key={row.publicationId} className="m-0 text-[12px] text-warning">Its data is not active here. If you moved it to a share link, open that publication.</p>)}
        <AccessBox capabilities={boxCapabilities} approved={changed && approval ? approvedCapability(approval) : null} failed={localReview.status === "failed" || candidateState === "failed"}
          onRetry={() => localReview.status === "failed" ? setLocalReload(value => value + 1) : void prepareLocalCandidate()} />
        {showLinks ? <section aria-labelledby="app-links-title">
          <h3 id="app-links-title" className="m-0 mb-2 text-[13px] font-medium text-ink">Share links</h3>
          <ul className="m-0 list-none divide-y divide-line rounded-lg border border-line bg-bg p-0">
            {linkRows.map(publication => <li key={publication.publicationId} className="flex items-center gap-2 px-3 py-2 text-[13px]">
              <LinkIcon size={12} aria-hidden className="shrink-0 text-muted" />
              <span className={`min-w-0 flex-1 truncate ${publication.operatorTakedown || !publication.linkCurrent ? "text-warning" : "text-ink"}`}>
                {publication.operatorTakedown ? "Disabled by server operator" : !publication.linkCurrent ? "Link changed" : "Published on a share link"}</span>
              <span className="shrink-0 text-[12px] text-muted">Link {publication.grantId.slice(0, 8)}</span>
              {publication.active && !publication.operatorTakedown ? <SecondaryButton size="row" disabled={!!busy || responsesBusy} aria-label={`Unpublish ${publication.publicationId}`} onClick={() => setPendingWithdraw(publication)}>
                {busy === "withdraw" && busyPublicationId === publication.publicationId ? "Unpublishing…" : "Unpublish"}</SecondaryButton> : null}
            </li>)}
            <li className="flex items-center gap-2 px-3 py-2 text-[13px]">
              {linkRows.length === 0 ? <><LinkIcon size={12} aria-hidden className="shrink-0 text-muted" /><span className="flex-1 text-muted">Not on a link</span></> : <span className="flex-1" />}
              <SecondaryButton size="row" disabled={!!busy || responsesBusy} onClick={() => { setError(null); setNotice(null); setView("links"); }}>Publish on a link</SecondaryButton>
            </li>
          </ul>
        </section> : null}
        {status}
        {approveFailed !== null ? <p role="alert" title={approveFailed} className="m-0 text-right text-[13px] text-danger">dohc could not approve this app. Try again.</p> : null}
        <footer className="flex items-center gap-2">
          {approval ? <SecondaryButton disabled={!!busy || responsesBusy} aria-busy={busy === "withdraw" && busyPublicationId === approval.publicationId} onClick={() => void withdraw(approval, true)}>Remove approval</SecondaryButton> : null}
          <span className="flex-1" />
          {approval && review ? null : <SecondaryButton disabled={committing} onClick={props.onClose}>Cancel</SecondaryButton>}
          {approval && !changed ? <PrimaryButton disabled={committing} onClick={props.onClose}>Done</PrimaryButton> :
            <PrimaryButton data-testid="app-publication-approve" aria-busy={localReview.status === "loading" || approving} disabled={!review || !canApprove} onClick={() => void approveLocal()}>
              {approval ? "Approve changes" : "Approve and open"}</PrimaryButton>}
        </footer>
      </> : prepared ? <>
        {status}
        <h3 ref={reviewHeading} tabIndex={-1} className="m-0 text-[13px] font-medium text-ink">Review app publication</h3>
        <p className="m-0 text-[13px] text-ink">{reactivating ? "Republish this stored revision. It does not include later source edits." : "Publish this captured app. Later source edits need a new publication."}</p>
        <div className="text-[12px] text-muted"><span className="font-medium text-ink">Link</span><p className="m-0 break-words">{preparedLink}</p></div>
        <div><h3 className="m-0 text-[13px] font-medium text-ink">Files included</h3>
          <ul data-testid="app-publication-source-paths" className="mb-0 mt-2 max-h-40 list-none overflow-y-auto rounded-md border border-line bg-bg p-2 font-mono text-[12px] text-muted">
            {prepared.sourcePaths.map(path => <li key={path} className="break-all">{path}</li>)}
          </ul>
        </div>
        <div className="space-y-2 text-[13px] text-muted"><h3 className="m-0 text-[13px] font-medium text-ink">Workspace data access</h3>
          {prepared.capabilities.length === 0 ? <p className="m-0">None</p> : prepared.capabilities.map(capability => capability.kind === "dataset" ? <DatasetApproval reportError={reportError} workspaceId={props.workspaceId} key={collectionKey(prepared.approvalId, capability.datasetId)} moves={!reactivating}
            onPlace={server => collectionPlaced(collectionKey(prepared.approvalId, capability.datasetId), server)} capability={!reactivating ? { ...capability, ...(linkReads.length ? { linkReads } : {}) } : capability} /> :
            <CollectionApproval key={capability.collectionPath} capability={capability} />)}
          {!reactivating ? prepared.capabilities.filter(capability => capability.kind === "dataset" && capability.operations.some(operation => operation.access === "helper" && operation.fields !== undefined)).map(capability => capability.kind === "dataset" ? <fieldset key={capability.datasetId} disabled={!!busy} className="space-y-2 border-0 p-0">
            <legend className="text-[13px] font-medium text-ink">Allow people with the link to read</legend>
            {capability.operations.filter(operation => operation.access === "helper" && operation.fields !== undefined).map(operation => <label key={operation.operationId} className="block text-[13px] text-ink">
              <input type="checkbox" checked={linkReads.some(read => read.operationId === operation.operationId)} onChange={event => setLinkReads(previous => event.target.checked
                ? [...previous, { operationId: operation.operationId, fieldIds: operation.fields!.map(field => field.fieldId) }]
                : previous.filter(read => read.operationId !== operation.operationId))} /> {operation.name}
              <span className="block text-[12px] text-muted">Fields: {operation.fields!.map(field => field.name).join(", ") || "None"}</span>
            </label>)}
            <p className="m-0 text-[12px] text-muted">Approved reads show current records and later changes. People with the link can use only the selected reads. Unpublish to withdraw access.</p>
          </fieldset> : null) : null}
          {collectionMoves.map(move => <CollectionMoveNote key={move.key} action="Publishing" server={move.server} className="m-0" />)}
          <p className="m-0">The app can use external services and send them data it receives.</p>
          <p className="m-0">Unpublishing stops new access through dohc. It cannot remove copies sent elsewhere.</p>
        </div>
        <details className="text-[12px] text-muted"><summary className="cursor-pointer">Publication revision</summary>
          <dl className="space-y-2 font-mono"><div><dt>Version</dt><dd className="m-0 break-all">{prepared.versionId}</dd></div>
            <div><dt>Source</dt><dd className="m-0 break-all">{prepared.sourceRevision}</dd></div>
            <div><dt>Publication</dt><dd data-testid="app-publication-digest" className="m-0 break-all">{prepared.candidateDigest}</dd></div></dl>
        </details>
        <footer className="flex justify-end gap-2"><SecondaryButton disabled={!!busy || responsesBusy} onClick={back}>Back</SecondaryButton>
          <PrimaryButton data-testid="app-publication-approve" disabled={!!busy || responsesBusy || collectionsUnchecked} onClick={() => void approve()}>{busy === "approve" ? "Publishing…" : reactivating ? "Republish this revision" : "Publish this revision"}</PrimaryButton></footer>
      </> : <>
        {status}
        {synced === false ? null : <div className="border-b border-line pb-4">
          <div className="flex items-center justify-between gap-3"><h3 className="m-0 text-[13px] font-medium text-ink">Publications</h3>
            <SecondaryButton disabled={publicationsLoading || !!busy || responsesBusy} onClick={() => setPublicationsReload(value => value + 1)}>Reload publications</SecondaryButton></div>
          {publicationsLoading || synced === null ? <SkeletonRows rows={2} label="Loading publications…" className="mt-3" /> : publicationsError ?
            <p role="alert" className="mb-0 text-[13px] text-danger">{publicationsError}</p> : publications.length === 0 ?
              <p className="mb-0 text-[12px] text-muted">No publications.</p> : <ul className="m-0 mt-3 list-none space-y-3 p-0">
                  {publications.map(publication => <li key={publication.publicationId} className="flex items-center justify-between gap-3">
                  <div className="min-w-0 text-[12px] text-muted"><p className="m-0 break-all">Link {publication.grantId.slice(0, 8)} · {publication.operatorTakedown ? "Disabled by server operator" : !publication.linkCurrent ? "Link changed" : publication.active ? "Published" : "Unpublished"}</p>
                    {publication.operatorTakedown ? <><p className="m-0 break-words whitespace-pre-wrap text-warning">{publication.operatorTakedown.reason}</p><p className="m-0">Contact the server operator about this publication.</p></> : null}
                    {!publication.operatorTakedown && !publication.linkCurrent ? <p className="m-0 text-warning">This publication is unavailable. Choose a current link below and review the app again.</p> : null}
                    {publication.manifestUnavailable ? <><p className="m-0 text-warning">Source details unavailable. This publication may belong to another app.</p>
                      <p className="m-0 break-all font-mono">{publication.publicationId}</p></> :
                      <p className="m-0 truncate font-mono" title={publication.sourceRevision}>Source {publication.sourceRevision.slice(0, 12)}</p>}
                    {publication.collectionCapability === "unavailable" ? <p className="mb-0 mt-1 text-warning">Collection access details unavailable. You can still revoke access.</p> : publication.collectionCapability ? <details className="mt-1"><summary className="cursor-pointer">Approved collection access</summary>
                      <p className="mb-0 break-all font-mono">{publication.collectionCapability.collectionPath}</p>
                      <p className="mb-0 break-words">Create: {publication.collectionCapability.allowedFields.join(", ")}</p>
                      <p className="mb-0 break-words">Required: {publication.collectionCapability.requiredFields.join(", ") || "None"}</p>
                      <p className="mb-0 break-words">Shown in the app: {publication.collectionCapability.readFields.join(", ") || "None"}</p>
                      <p className="mb-0">People with this share can read every response file and all its fields.</p>
                    </details> : publication.datasetCapability ? null : <p className="mb-0 mt-1">No collection access</p>}
                    {publication.datasetCapability === "unavailable" ? <p className="mb-0 mt-1 text-warning">Collection access details unavailable.</p> : publication.datasetCapability ? <details className="mt-1"><summary className="cursor-pointer">Approved Collection access</summary><DatasetApproval reportError={reportError} workspaceId={props.workspaceId} capability={publication.datasetCapability} /><p className="mb-0">Open the Collection to view and manage its records.</p></details> : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    {publication.collectionCapability ? <SecondaryButton disabled={!!busy || responsesBusy} aria-label={`Revoke collection access ${publication.publicationId}`} onClick={() => setPendingRevoke(publication)}>{busy === "revokeCollection" && busyPublicationId === publication.publicationId ? "Revoking…" : "Revoke collection access"}</SecondaryButton> : null}
                    {publication.active ? <SecondaryButton disabled={!!busy || responsesBusy} aria-label={`Unpublish ${publication.publicationId}`} onClick={() => setPendingWithdraw(publication)}>{busy === "withdraw" && busyPublicationId === publication.publicationId ? "Unpublishing…" : "Unpublish"}</SecondaryButton> :
                      publication.operatorTakedown || !publication.linkCurrent ? null : publication.manifestUnavailable ? <span className="text-[12px] text-muted">Source unavailable</span> : <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => void reviewReactivation(publication)}>{busy === "prepare" && busyPublicationId === publication.publicationId ? "Loading revision…" : "Review and republish"}</SecondaryButton>}
                  </div>
                </li>)}
              </ul>}
        </div>}
        {[...new Set(publications.filter(publication => !publication.manifestUnavailable && publication.collectionCapability && publication.appRoot === props.appRoot).map(publication => publication.grantId))].map(grantId => <div key={grantId}>
          <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">Link {grantId}</p>
          <OwnerAppResponses workspaceId={props.workspaceId} grantId={grantId} disabled={publicationsLoading || !!busy} onBusyChange={responseBusyChanged} />
        </div>)}
        <div><h3 className="m-0 text-[13px] font-medium text-ink">Publish on a share link</h3>
          <p className="mb-0 mt-1 text-[12px] text-muted">{synced === false ? "Sync this workspace to publish on a share link. Opening on this device does not need sync." : "Publishing on a link needs a connection to your dohc host. Approval for this device does not."}</p></div>
        {synced === false ? null : <>
          <label className="text-[13px] text-ink">Share link
            <select aria-label="Publication share link" disabled={loading || !!busy || responsesBusy} value={selected} onChange={event => setSelected(event.target.value)}
              className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink">
              <option value="">Choose a link</option>{links.map(link => <option key={link.grantId} value={link.grantId}>{linkLabel(link)}</option>)}
            </select></label>
          {loading || synced === null ? <SkeletonRows rows={2} label="Loading links…" /> : loadError ? <div><p role="alert" className="text-[13px] text-danger">{loadError}</p><SecondaryButton onClick={() => setReload(value => value + 1)}>Reload links</SecondaryButton></div> : links.length === 0 ?
            <p className="m-0 text-[13px] text-muted">No active links include this app's source folder.</p> : null}
        </>}
        {props.onShareSource ? <div className="flex items-center justify-between gap-3"><p className="m-0 text-[12px] text-muted">Create a link that includes this app's source files.</p>
          <SecondaryButton disabled={!!busy || responsesBusy} onClick={() => { props.onClose(); props.onShareSource?.(); }}>Share app folder</SecondaryButton></div> : null}
        {synced === false ? null : <p className="m-0 text-[13px] text-muted">Prepare the app to review its source and data access before publishing.</p>}
        <footer className="flex justify-end gap-2">
          {props.localApproval ? <SecondaryButton disabled={committing} onClick={() => { setError(null); setNotice(null); setView("local"); }}>Back</SecondaryButton> :
            <SecondaryButton disabled={committing} onClick={props.onClose}>Cancel</SecondaryButton>}
          {synced === false ? null : <PrimaryButton disabled={!!busy || responsesBusy || !selectedLink || loading || !!loadError} onClick={() => void prepare()}>{busy === "prepare" && !busyPublicationId ? "Preparing app…" : "Prepare app"}</PrimaryButton>}</footer>
      </>}
      </section></Overlay>
      {pendingRevoke ? <ConfirmDialog intent="danger" testId="app-collection-revoke-confirm" cancelTestId="app-collection-revoke-cancel" confirmTestId="app-collection-revoke-action" title="Revoke collection access?" confirmLabel="Revoke access" onCancel={closeRevocation} onConfirm={() => { const value = pendingRevoke; closeRevocation(); void revokeCollection(value); }}>
        <p className="mt-3 mb-0 text-[13px] text-muted">The app stays published. It can no longer read the collection or accept responses through dohc.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">Saved responses stay in your workspace. Copies already received cannot be removed.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">Prepare the app again to review and restore access.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">To reduce access, revoke it first. Change the app's data request, then prepare and review a new publication.</p>
        {pendingRevoke.manifestUnavailable ? <p className="mt-2 mb-0 text-[13px] text-warning">Source details are unavailable. This publication may belong to another app.</p> : null}
        <p className="mt-2 mb-0 break-all font-mono text-[12px] text-muted">{pendingRevoke.publicationId}</p>
      </ConfirmDialog> : null}
      {pendingWithdraw ? <ConfirmDialog intent="danger" testId="app-publication-withdraw-confirm" cancelTestId="app-publication-withdraw-cancel" confirmTestId="app-publication-withdraw-confirm-action" title="Unpublish this app?" confirmLabel="Unpublish app" onCancel={closeWithdrawal} onConfirm={() => { const value = pendingWithdraw; closeWithdrawal(); void withdraw(value); }}>
        <p className="mt-3 mb-0 text-[13px] text-muted">This stops new access through dohc. It cannot remove copies sent elsewhere.</p>
        <p className="mt-2 mb-0 text-[13px] text-muted">{!pendingWithdraw.linkCurrent ? "This publication belongs to a changed link. Choose a current link to publish the app again." : pendingWithdraw.manifestUnavailable ? "Source details are unavailable. This publication may belong to another app and cannot currently be republished." : "You can review this stored revision and publish it again."}</p>
        <p className="mt-2 mb-0 break-all font-mono text-[12px] text-muted">{pendingWithdraw.manifestUnavailable ? pendingWithdraw.publicationId : pendingWithdraw.appRoot}</p>
      </ConfirmDialog> : null}
  </>;
}
