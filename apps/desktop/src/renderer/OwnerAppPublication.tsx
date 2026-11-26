import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  EyeOff,
  Link as LinkIcon,
  LogIn,
  Table2,
  TriangleAlert,
  Unlink,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AppDatasetCapability } from "@dohc/security-contract/dataset";
import { secretPrefixLabel } from "@dohc/security-contract/secret-prefix";
import type { RelayShareLinkRow, SyncStatusResult } from "../ipc/bridgeContract";
import {
  OwnerAppPublicationResult,
  type OwnerAppPublicationRequest,
} from "../ipc/ownerAppPublicationContract";
import {
  AppAccessSummary,
  CollectionPermissionCard,
  DatasetPermissionCard,
  ExternalNetworkCard,
  type AppCapability,
  type LinkReadChoice,
  type ReportPermissionError,
} from "./AppPermissionsCard";
import { bridge } from "./bridge";
import { ipcErrorMessage } from "./ipcError";
import { Overlay } from "./Overlay";
import { OwnerAppResponses } from "./OwnerAppResponses";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { CopyButton } from "./ui/CopyButton";
import { IconButton, Pill, PrimaryButton, SecondaryButton } from "./ui/controls";
import { SkeletonRows } from "./ui/SkeletonRows";
import { syncNamesServer } from "./workbench/WorkspaceSyncStatus";
import { accessReasonForLane, serverName, type AccessContext } from "./workbench/accessReason";

type Prepared = Extract<OwnerAppPublicationResult, { kind: "prepared" }>;
type StagedProposal = Extract<OwnerAppPublicationResult, { kind: "staged" }>["stage"];
const collectionKey = (approvalId: string, datasetId: string) => `${approvalId}\0${datasetId}`;
type Publication = Extract<OwnerAppPublicationResult, { kind: "listed" }>["publications"][number];
type LocalPublication = Extract<
  OwnerAppPublicationResult,
  { kind: "localListed" }
>["publications"][number];
type ActiveLink = RelayShareLinkRow & { selector: NonNullable<RelayShareLinkRow["selector"]> };

const responses = (count: number) => `${count} ${count === 1 ? "response" : "responses"}`;
const unconfirmedResponses = (count: number) => `${responses(count)} not yet confirmed`;
const unconfirmedRemoval = (count: number) =>
  `dohc removed this app's approval but has not confirmed whether ${responses(count)} ${count === 1 ? "was" : "were"} saved.`;

const PUBLICATION_ID = /^[a-f0-9]{64}$/;
const MEMBERS = "workspace";
const MEMBERS_LABEL = "Workspace members";
const APP_LINK_SECRET = {
  what: "the app link",
  again: "Open Review app to copy it again.",
} as const;

export function appLinkUrl(
  shareUrl: string | null | undefined,
  publicationId: string,
): string | null {
  if (!shareUrl || !PUBLICATION_ID.test(publicationId)) return null;
  let url: URL;
  try {
    url = new URL(shareUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.searchParams.set("app", publicationId);
  return url.toString();
}

/** The local launcher answers with a loopback address only. Anything else never reaches the browser. */
export function localLaunchUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  return url.protocol === "http:" &&
    url.hostname === "127.0.0.1" &&
    url.port !== "" &&
    url.username === "" &&
    url.password === ""
    ? url.toString()
    : null;
}

/** Starts an approved app on this device and hands its loopback address to the browser. False when the caller went stale first. */
export async function openLocalApp(
  api: ReturnType<typeof bridge>,
  workspaceId: string,
  publicationId: string,
  current: () => boolean,
): Promise<boolean> {
  const result = await api.publishOwnerApp({ action: "launchLocal", workspaceId, publicationId });
  if (!current()) return false;
  if (result.kind !== "localLaunched" || result.publicationId !== publicationId)
    throw new Error("dohc could not confirm which app started.");
  const url = localLaunchUrl(result.url);
  if (!url) throw new Error("The app address is not on this device. dohc did not open it.");
  await api.openExternalUrl({ url });
  return current();
}

function verifiedPrepared(result: OwnerAppPublicationResult): Prepared {
  const checked = OwnerAppPublicationResult.safeParse(result);
  if (!checked.success || checked.data.kind !== "prepared")
    throw new Error("dohc could not verify this app's data access. Prepare the app again.");
  return checked.data;
}

type Checked = Extract<OwnerAppPublicationResult, { kind: "localChecked" }>;
const checkFailed = "dohc could not check whether this app is approved on this device.";
const sourceCheckFailed =
  "dohc could not check whether this app's source changed since you approved it.";

/** An approval of an app that reaches no workspace data has no capability. */
const approvedCapabilities = (row: LocalPublication): AppCapability[] =>
  "datasetCapabilities" in row
    ? row.datasetCapabilities
    : "datasetCapability" in row
      ? [row.datasetCapability]
      : "collectionCapability" in row
        ? [row.collectionCapability]
        : [];
function StateLine({
  icon: Icon,
  tone,
  text,
  children,
}: {
  icon: LucideIcon;
  tone: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div data-testid="app-review-state" className="flex items-start gap-2 text-[13px] text-ink">
      <Icon size={16} aria-hidden className={`mt-0.5 shrink-0 ${tone}`} />
      <div className="min-w-0">
        <p className="m-0">{text}</p>
        {children}
      </div>
    </div>
  );
}
const More = ({ children }: { children: ReactNode }) => (
  <p className="m-0 mt-1 text-[12px] text-muted">{children}</p>
);

// onLocalChange runs after anything that may change this device's approvals, so other views read them again.
// localApproval says how an app approved here opens: in its tab, in the browser, or not at all when it has no app.publish.json.
// access: the shell's workspace server connection, and that server's address, so a signed-out Share links box can say so.
type PublicationProps = {
  workspaceId: string;
  appRoot: string;
  title?: string;
  localApproval?: "tab" | "browser" | null;
  onShareSource?: () => void;
  reportError?: ReportPermissionError;
  onLocalChange?: () => void;
  onCollectionsChange?: () => void;
  access?: { context: AccessContext; server: string | null };
};

type ControlProps = PublicationProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  testId: string;
};

/** Lists app source files that hold a likely secret token. It never blocks the review. */
export function LikelySecretsWarning(props: { secrets: Prepared["likelySecrets"] }) {
  const count = props.secrets.length;
  return (
    <div
      data-testid="app-publication-likely-secrets"
      className="mt-2 flex items-start gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-[12px] text-muted"
    >
      <TriangleAlert size={14} aria-hidden className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 space-y-1">
        <p className="m-0 text-ink">
          {count === 1 ? "1 file holds" : `${count} files hold`} a likely secret token. Remove each
          token from the app's source.
        </p>
        <ul className="m-0 list-none p-0">
          {props.secrets.map(({ path, prefix }) => (
            <li key={path} className="break-all">
              {path} has {secretPrefixLabel(prefix)}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Review app: the person's one way to see what the app can reach, and to approve or publish it. */
export function OwnerAppPublication(props: ControlProps) {
  return <PublicationControl key={`${props.workspaceId}\0${props.appRoot}`} {...props} />;
}

function PublicationControl(props: ControlProps) {
  return (
    <>
      <SecondaryButton
        size="compact"
        data-testid={props.testId}
        onClick={() => props.onOpenChange(true)}
      >
        Review app
      </SecondaryButton>
      {props.open ? (
        <PublicationDialog
          {...props}
          onClose={() => props.onOpenChange(false)}
          onReopen={() => props.onOpenChange(true)}
        />
      ) : null}
    </>
  );
}

function PublishedDatasetDetails({
  capability,
  workspaceId,
  reportError,
}: {
  capability: AppDatasetCapability;
  workspaceId: string;
  reportError: ReportPermissionError;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-1" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer">Approved Collection access</summary>
      {open ? (
        <div className="mt-2 space-y-2">
          <DatasetPermissionCard
            reportError={reportError}
            workspaceId={workspaceId}
            capability={capability}
            narrow
            loadDisplay
          />
          <p className="m-0">Open the Collection to view and manage its records.</p>
        </div>
      ) : null}
    </details>
  );
}

function linkLabel(link: ActiveLink) {
  const paths = link.selector.paths.join(", ") || "Workspace";
  const version = link.selector.versionId ? ` · Version ${link.selector.versionId}` : "";
  return `${paths}${version} · ${link.access} · ${link.grantId.slice(0, 8)}`;
}

function stagedStateHeading(staged: StagedProposal): string {
  const created = staged.collections.filter((entry) => entry.action === "create").length;
  const updated = staged.collections.filter((entry) => entry.action === "migrate").length;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new ${created === 1 ? "Collection" : "Collections"}`);
  if (updated > 0) parts.push(`${updated} updated ${updated === 1 ? "Collection" : "Collections"}`);
  if (parts.length === 0) return "Approve this staged version on this device.";
  return `Review ${parts.join(" and ")} and approve this app.`;
}

function StagedCollectionsBox({ collections }: { collections: StagedProposal["collections"] }) {
  const id = useId();
  if (collections.length === 0) return null;
  return (
    <section aria-labelledby={id} data-testid="staged-app-collections">
      <h3 id={id} className="m-0 mb-2 text-[13px] font-medium text-ink">
        Collections
      </h3>
      <div className="divide-y divide-line rounded-lg border border-line bg-bg">
        {collections.map((collection) => (
          <div key={collection.datasetId} className="flex flex-col gap-1.5 px-3 py-3">
            <div className="flex items-center gap-2">
              <Table2 size={14} aria-hidden className="shrink-0 text-muted" />
              <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                {collection.name}
              </span>
              {collection.alias ? (
                <span className="shrink-0 font-mono text-[11px] text-muted">
                  {collection.alias}
                </span>
              ) : null}
              <span className="flex-1" />
              {collection.action === "create" ? (
                <Pill tone={collection.applied ? "success" : "warning"}>
                  {collection.applied ? "Created" : "New"}
                </Pill>
              ) : collection.action === "migrate" ? (
                <Pill tone={collection.applied ? "success" : "warning"}>
                  {collection.applied ? "Updated" : "Update"}
                </Pill>
              ) : (
                <Pill>Existing</Pill>
              )}
            </div>
            {collection.action === "create" && collection.tables?.length ? (
              <ul className="m-0 list-none space-y-1 pl-5 text-[12px] text-muted">
                {collection.tables.map((table) => (
                  <li key={table.name}>
                    <span className="font-medium text-ink">{table.name}</span>
                    {table.fields.length ? `: ${table.fields.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            ) : collection.action === "migrate" && collection.changes?.length ? (
              <ul className="m-0 list-none space-y-1 pl-5 text-[12px] text-muted">
                {collection.changes.map((change, index) => (
                  <li key={`${change.kind}-${index}`}>{change.summary}</li>
                ))}
              </ul>
            ) : collection.action === "unchanged" ? (
              <p className="m-0 pl-5 text-[12px] text-muted">No rule changes.</p>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}

type LocalReview =
  | { status: "loading" }
  | { status: "failed" }
  | {
      status: "ready";
      rows: LocalPublication[];
      approval: LocalPublication | null;
      source: Checked | null;
      staged: StagedProposal | null;
    };

function PublicationDialog(
  props: PublicationProps & { onClose: () => void; onReopen: () => void },
) {
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
  const [preparedForMembers, setPreparedForMembers] = useState(false);
  const [busy, setBusy] = useState<
    "prepare" | "approve" | "withdraw" | "revokeCollection" | "open" | null
  >(null);
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
    setResponseRequests((previous) => {
      if (previous.has(grantId) === active) return previous;
      const next = new Set(previous);
      if (active) next.add(grantId);
      else next.delete(grantId);
      return next;
    });
  }, []);
  const [publicationsError, setPublicationsError] = useState<string | null>(null);
  const [publicationsReload, setPublicationsReload] = useState(0);
  // Share links stays hidden when the server does not publish apps here, or when the sync status already says it is unreachable.
  const [linksHidden, setLinksHidden] = useState(false);
  // The server failed to return this app's links. Share links then keeps its label with one line and Try again.
  const [linksFailed, setLinksFailed] = useState(false);
  // Local approvals need no host, so they load and fail independently of links and shared publications.
  const [localReview, setLocalReview] = useState<LocalReview>({ status: "loading" });
  const [localReload, setLocalReload] = useState(0);
  // The candidate the person approves here. It stays on screen while a replacement prepares.
  const [localCandidate, setLocalCandidate] = useState<Prepared | null>(null);
  const [candidateState, setCandidateState] = useState<"idle" | "loading" | "failed">("idle");
  const [approveFailed, setApproveFailed] = useState<string | null>(null);
  // Opening an approved app in the browser failed. It shows here while the dialog is open, and goes to Notices when it closes.
  const [openFailed, setOpenFailed] = useState<string | null>(null);
  const openFailure = useRef<{ publicationId: string; cause: unknown } | null>(null);
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
  const selectedLink = links.find((link) => link.grantId === selected);
  const committing =
    busy === "approve" || busy === "withdraw" || busy === "revokeCollection" || responsesBusy;
  // Backend data errors go to the shell's Notices when root passes reportShellError; otherwise this dialog's own alert line.
  const reportError: ReportPermissionError =
    props.reportError ?? ((fallback, cause) => setError(ipcErrorMessage(cause, fallback)));
  const report = useRef(reportError);
  report.current = reportError;
  const localChanged = () => {
    setLocalReload((value) => value + 1);
    props.onLocalChange?.();
  };
  const title = props.title || props.appRoot.split("/").pop() || props.appRoot;

  useEffect(() => {
    (prepared ? reviewHeading.current : heading.current)?.focus();
  }, [prepared, view]);

  const cancel = (value: Prepared | null) => {
    if (value)
      void api
        .publishOwnerApp({
          action: "cancel",
          workspaceId: props.workspaceId,
          approvalId: value.approvalId,
        })
        .catch(() => undefined);
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current += 1;
      cancel(candidate.current);
      cancel(localCandidateRef.current);
      const failure = openFailure.current;
      if (failure) openAgain.current(failure.publicationId, failure.cause);
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
        const page = await api.listRelayShareLinks({
          workspaceId: props.workspaceId,
          ...(cursor ? { cursor } : {}),
        });
        if (!current) return;
        for (const row of page.links) {
          if (
            row.status === "active" &&
            row.revokedAtMs === null &&
            row.selector !== null &&
            (row.selector.paths.length === 0 ||
              row.selector.paths.some(
                (path) => props.appRoot === path || props.appRoot.startsWith(path + "/"),
              )) &&
            !rows.some((link) => link.grantId === row.grantId)
          )
            rows.push(row as ActiveLink);
        }
        cursor = page.nextCursor;
        if (cursor && seen.has(cursor)) throw new Error("The link list changed. Reload the links.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (current) {
        setLinks(rows);
        setSelected((value) =>
          value === MEMBERS || rows.some((link) => link.grantId === value) ? value : "",
        );
      }
    })()
      .catch((error) => {
        if (current) setLoadError(ipcErrorMessage(error, "dohc could not load the links."));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, props.workspaceId, props.appRoot, reload]);

  // Signed out of the workspace's server: Share links offers Connect server instead of reading the list.
  // The links view keeps its own errors, so only the review on this device skips the list.
  const linksSignedOut =
    !!props.localApproval &&
    !!props.access &&
    accessReasonForLane(props.access.context.facts, "granted") === "signed-out";
  useEffect(() => {
    let current = true;
    setPublicationsLoading(true);
    setPublicationsError(null);
    setLinksHidden(false);
    if (linksSignedOut) {
      setPublications([]);
      setLinksFailed(false);
      setPublicationsLoading(false);
      return;
    }
    void (async () => {
      const rows: Publication[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api.publishOwnerApp({
          action: "list",
          workspaceId: props.workspaceId,
          appRoot: props.appRoot,
          ...(cursor ? { cursor } : {}),
        });
        if (!current) return;
        if (page.kind === "listUnavailable") {
          setPublications([]);
          setLinksHidden(true);
          setLinksFailed(false);
          return;
        }
        if (page.kind !== "listed") throw new Error("dohc could not load app publications.");
        for (const row of page.publications) {
          if (
            (row.manifestUnavailable || row.appRoot === props.appRoot) &&
            !rows.some((value) => value.publicationId === row.publicationId)
          )
            rows.push(row);
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error("The publication list changed. Try again.");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (current) {
        setPublications(rows);
        setLinksFailed(false);
      }
    })()
      .catch(async (error) => {
        if (!current) return;
        // Offline, or stopped until one side updates: the title bar already
        // reports it, so Share links adds nothing of its own.
        let status: SyncStatusResult | null = null;
        try {
          status = await api.getSyncStatus({ workspaceId: props.workspaceId });
        } catch {
          /* Without a status, the line shows. */
        }
        if (!current) return;
        setPublicationsError(ipcErrorMessage(error, "dohc could not load app publications."));
        const offline = syncNamesServer(status) || status?.updateRequired !== undefined;
        setLinksHidden(offline);
        setLinksFailed(!offline);
      })
      .finally(() => {
        if (current) setPublicationsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [api, props.workspaceId, props.appRoot, publicationsReload, linksSignedOut]);

  useEffect(() => {
    let current = true;
    void (async () => {
      const status = await api.cloudStatus({ workspaceId: props.workspaceId });
      if (current) setSynced(status.workspaceSynced !== false);
    })().catch(() => {
      if (current) setSynced(true);
    });
    return () => {
      current = false;
    };
  }, [api, props.workspaceId]);

  // The approval here, then whether the source still matches it. Neither compiles the app.
  useEffect(() => {
    if (!props.localApproval) return;
    let current = true;
    setLocalReview({ status: "loading" });
    setCandidateState((value) => (value === "failed" ? "idle" : value));
    void (async () => {
      const page = await api.publishOwnerApp({
        action: "listLocal",
        workspaceId: props.workspaceId,
        appRoot: props.appRoot,
      });
      if (!current) return;
      if (page.kind !== "localListed") throw new Error(checkFailed);
      const rows = page.publications.filter((row) => row.appRoot === props.appRoot);
      const approval = rows.find((row) => row.approved) ?? null;
      // The approval is known even when its source check fails, so the dialog keeps it and treats the source as unchanged.
      // Without an approval, a failed check leaves preparation to report the problem.
      let source: Checked | null = null;
      try {
        const checked = await api.publishOwnerApp({
          action: "checkLocal",
          workspaceId: props.workspaceId,
          appRoot: props.appRoot,
        });
        if (checked.kind !== "localChecked" || checked.appRoot !== props.appRoot)
          throw new Error(sourceCheckFailed);
        source = checked;
      } catch (error) {
        if (!current) return;
        if (approval)
          report.current(sourceCheckFailed, error, () => {
            if (alive.current) setLocalReload((value) => value + 1);
            else props.onReopen();
          });
      }
      const listed = await api.publishOwnerApp({
        action: "listStaged",
        workspaceId: props.workspaceId,
        appRoot: props.appRoot,
      });
      const staged: StagedProposal | null =
        listed && listed.kind === "stagedListed"
          ? (listed.stages.find((entry) => entry.appRoot === props.appRoot) ?? null)
          : null;
      if (!current) return;
      setLocalReview({ status: "ready", rows, approval, source, staged });
    })().catch((error) => {
      if (!current) return;
      setLocalReview({ status: "failed" });
      report.current(checkFailed, error, () => {
        if (alive.current) setLocalReload((value) => value + 1);
        else props.onReopen();
      });
    });
    return () => {
      current = false;
    };
  }, [api, props.workspaceId, props.appRoot, props.localApproval, localReload]);

  const review = localReview.status === "ready" ? localReview : null;
  const approval = review?.approval ?? null;
  const staged = review?.staged ?? null;
  const changed =
    !!approval && !!review?.source && review.source.sourceRevision !== approval.sourceRevision;
  const needsCandidate = !!review && !staged && (!approval || changed);

  // A first review or changed source shows the exact candidate, so approval binds what the person read.
  const prepareLocalCandidate = async () => {
    const mine = ++request.current;
    preparing.current = mine;
    setCandidateState("loading");
    try {
      const result = await api.publishOwnerApp({
        action: "prepareLocal",
        workspaceId: props.workspaceId,
        appRoot: props.appRoot,
      });
      const fresh = alive.current && mine === request.current;
      if (
        !fresh ||
        result.kind !== "prepared" ||
        result.appRoot !== props.appRoot ||
        result.local !== true
      ) {
        if (result.kind === "prepared") cancel(result);
        if (!fresh) return;
        throw new Error("dohc could not prepare this app.");
      }
      let verified: Prepared;
      try {
        verified = verifiedPrepared(result);
      } catch (cause) {
        cancel(result);
        throw cause;
      }
      cancel(localCandidateRef.current);
      localCandidateRef.current = verified;
      setLocalCandidate(verified);
      setCandidateState("idle");
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      cancel(localCandidateRef.current);
      localCandidateRef.current = null;
      setLocalCandidate(null);
      setCandidateState("failed");
      // After the dialog closes, Try again reopens it so the owner can prepare the app again.
      reportError("dohc could not prepare this app.", new Error(ipcErrorMessage(cause, "")), () => {
        if (alive.current) retryPreparation();
        else props.onReopen();
      });
    } finally {
      // Another action took over, so a later render prepares again if the review still needs it.
      if (alive.current && mine !== request.current && preparing.current === mine)
        setCandidateState("idle");
    }
  };
  useEffect(() => {
    if (view === "local" && needsCandidate && !localCandidate && candidateState === "idle" && !busy)
      void prepareLocalCandidate();
  });
  // A retry waits in this effect for any running action, so it never takes over an approval or a removal.
  const retryPreparation = () =>
    setCandidateState((value) => (value === "failed" ? "idle" : value));

  // Once the dialog has closed, Try again in Notices opens the app itself, as the person asked.
  const openFailedNotice = (publicationId: string, cause: unknown) =>
    report.current(
      "dohc could not open this app in your browser.",
      cause,
      () => void openApproved(publicationId, () => true),
    );
  const openAgain = useRef(openFailedNotice);
  openAgain.current = openFailedNotice;
  const openApproved = async (publicationId: string, current = () => alive.current) => {
    try {
      await openLocalApp(api, props.workspaceId, publicationId, current);
    } catch (cause) {
      openFailedNotice(publicationId, cause);
    }
  };
  // Open in browser while the dialog is open: a failure stays in place above the button that retries.
  const openInBrowser = async (publicationId: string) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("open");
    setOpenFailed(null);
    setError(null);
    openFailure.current = null;
    try {
      await openLocalApp(
        api,
        props.workspaceId,
        publicationId,
        () => alive.current && mine === request.current,
      );
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      openFailure.current = { publicationId, cause };
      setOpenFailed(ipcErrorMessage(cause, "dohc could not open this app in your browser."));
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };

  const approveStaged = async (proposal: StagedProposal) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("approve");
    setApproveFailed(null);
    setError(null);
    try {
      const result = await api.publishOwnerApp({
        action: "approveStaged",
        workspaceId: props.workspaceId,
        stageId: proposal.stageId,
        reviewDigest: proposal.reviewDigest,
      });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "stagedApproved")
        throw new Error("dohc could not confirm this approval.");
      localChanged();
      if (result.collectionsApplied.length > 0) props.onCollectionsChange?.();
      if (props.localApproval === "browser") await openApproved(result.publicationId);
      if (alive.current && mine === request.current) props.onClose();
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      setApproveFailed(ipcErrorMessage(cause, "dohc could not approve this staged review."));
      setLocalReload((value) => value + 1);
      props.onCollectionsChange?.();
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };

  const discardStaged = async (proposal: StagedProposal) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("withdraw");
    setApproveFailed(null);
    setError(null);
    try {
      const result = await api.publishOwnerApp({
        action: "discardStaged",
        workspaceId: props.workspaceId,
        stageId: proposal.stageId,
      });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "stagedDiscarded")
        throw new Error("dohc could not discard this staged review.");
      localChanged();
    } catch (cause) {
      if (!alive.current || mine !== request.current) return;
      setError(ipcErrorMessage(cause, "dohc could not discard this staged review."));
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };

  const approveLocal = async () => {
    const value = localCandidate;
    if (!value || busy || responsesBusy || candidateState !== "idle") return;
    const mine = ++request.current;
    setBusy("approve");
    setApproveFailed(null);
    setError(null);
    try {
      const result = await api.publishOwnerApp({
        action: "approve",
        workspaceId: props.workspaceId,
        approvalId: value.approvalId,
        candidateDigest: value.candidateDigest,
      });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published" || result.local !== true)
        throw new Error("dohc could not confirm this approval.");
      localCandidateRef.current = null;
      setLocalCandidate(null);
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
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };

  const prepareWith = async (
    input: Extract<OwnerAppPublicationRequest, { action: "prepare" }>,
    link: string,
  ) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("prepare");
    setError(null);
    setNotice(null);
    try {
      const result = await api.publishOwnerApp(input);
      if (!alive.current || mine !== request.current) {
        if (result.kind === "prepared") cancel(result);
        return;
      }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot || result.local === true) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not prepare this app.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(false);
      setLinkReads([]);
      setPreparedLink(link);
      setPreparedForMembers(input.audience === "workspace");
    } catch (cause) {
      if (alive.current && mine === request.current) {
        cancel(candidate.current);
        candidate.current = null;
        // After the dialog closes, Try again reopens it so the owner can prepare the app again.
        reportError(
          "dohc could not prepare this app.",
          new Error(ipcErrorMessage(cause, "")),
          () => {
            if (alive.current) void prepareWith(input, link);
            else props.onReopen();
          },
        );
      }
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };
  const prepare = () =>
    selected === MEMBERS
      ? prepareWith(
          {
            action: "prepare",
            workspaceId: props.workspaceId,
            appRoot: props.appRoot,
            audience: "workspace",
          },
          MEMBERS_LABEL,
        )
      : selectedLink
        ? prepareWith(
            {
              action: "prepare",
              workspaceId: props.workspaceId,
              appRoot: props.appRoot,
              shareId: selectedLink.shareId,
              grantId: selectedLink.grantId,
            },
            linkLabel(selectedLink),
          )
        : undefined;

  const reviewReactivation = async (publication: Publication) => {
    if (
      busy ||
      responsesBusy ||
      publication.manifestUnavailable ||
      publication.active ||
      !publication.linkCurrent
    )
      return;
    const mine = ++request.current;
    setBusy("prepare");
    setBusyPublicationId(publication.publicationId);
    setError(null);
    setNotice(null);
    try {
      const result = await api.publishOwnerApp({
        action: "reviewReactivation",
        workspaceId: props.workspaceId,
        publicationId: publication.publicationId,
      });
      if (!alive.current || mine !== request.current) {
        if (result.kind === "prepared") cancel(result);
        return;
      }
      if (result.kind !== "prepared" || result.appRoot !== props.appRoot) {
        if (result.kind === "prepared") cancel(result);
        throw new Error("dohc could not load this publication.");
      }
      candidate.current = result;
      const verified = verifiedPrepared(result);
      setPrepared(verified);
      setReactivating(true);
      setPreparedForMembers(publication.audience === "workspace");
      setPreparedLink(
        publication.audience === "workspace" ? MEMBERS_LABEL : `Link ${publication.grantId}`,
      );
    } catch (cause) {
      if (alive.current && mine === request.current) {
        cancel(candidate.current);
        candidate.current = null;
        setError(ipcErrorMessage(cause, "dohc could not load this publication."));
        setPublicationsReload((value) => value + 1);
      }
    } finally {
      if (alive.current && mine === request.current) {
        setBusy(null);
        setBusyPublicationId(null);
      }
    }
  };

  const approve = async () => {
    if (busy || responsesBusy || !prepared) return;
    const mine = ++request.current;
    setBusy("approve");
    setError(null);
    try {
      const result = await api.publishOwnerApp({
        action: "approve",
        workspaceId: props.workspaceId,
        approvalId: prepared.approvalId,
        candidateDigest: prepared.candidateDigest,
        ...(!reactivating &&
        !preparedForMembers &&
        prepared.capabilities.some((value) => value.kind === "dataset")
          ? { linkReads }
          : {}),
      });
      if (!alive.current || mine !== request.current) return;
      if (result.kind !== "published" || result.local === true)
        throw new Error("dohc could not confirm this publication.");
      candidate.current = null;
      localChanged();
      setPublicationsReload((value) => value + 1);
      setPrepared(null);
      setNotice(
        reactivating
          ? "App republished."
          : preparedForMembers
            ? "App published for workspace members."
            : "App published on the selected link.",
      );
    } catch (cause) {
      if (alive.current && mine === request.current) {
        cancel(prepared);
        candidate.current = null;
        setPrepared(null);
        localChanged();
        setPublicationsReload((value) => value + 1);
        setError(ipcErrorMessage(cause, "dohc could not confirm this publication."));
      }
    } finally {
      if (alive.current && mine === request.current) setBusy(null);
    }
  };

  const withdraw = async (publication: Publication | LocalPublication, local = false) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("withdraw");
    setBusyPublicationId(publication.publicationId);
    setError(null);
    setApproveFailed(null);
    setOpenFailed(null);
    openFailure.current = null;
    try {
      const result = await api.publishOwnerApp({
        action: "withdraw",
        workspaceId: props.workspaceId,
        publicationId: publication.publicationId,
        expectedAuthorityRevision: publication.authorityRevision,
      });
      if (!alive.current || mine !== request.current) return;
      if (
        local &&
        result.kind === "withdrawalUnconfirmed" &&
        result.publicationId === publication.publicationId
      ) {
        // Access ended. Trying again at the ending revision confirms responses the app sent before it.
        localChanged();
        reportError(unconfirmedRemoval(result.unresolvedCreates), undefined, () => {
          if (alive.current)
            void withdraw({ ...publication, authorityRevision: result.authorityRevision }, true);
        });
        return;
      }
      if (result.kind !== "withdrawn")
        throw new Error("dohc could not confirm that this publication ended. Try again.");
      // The review shows the removed approval itself, so only a link says what changed.
      if (local) localChanged();
      else {
        setPublicationsReload((value) => value + 1);
        setNotice(
          "audience" in publication && publication.audience === "workspace"
            ? "App unpublished for workspace members."
            : "App unpublished. The share link still works for its other shared content.",
        );
      }
    } catch (cause) {
      if (alive.current && mine === request.current) {
        setError(ipcErrorMessage(cause, "dohc could not end app access. Try again."));
        if (local) localChanged();
        else setPublicationsReload((value) => value + 1);
      }
    } finally {
      if (alive.current && mine === request.current) {
        setBusy(null);
        setBusyPublicationId(null);
      }
    }
  };
  const revokeCollection = async (publication: Publication) => {
    if (busy || responsesBusy) return;
    const mine = ++request.current;
    setBusy("revokeCollection");
    setBusyPublicationId(publication.publicationId);
    setError(null);
    try {
      const result = await api.publishOwnerApp({
        action: "revokeCollection",
        workspaceId: props.workspaceId,
        publicationId: publication.publicationId,
        expectedAuthorityRevision: publication.authorityRevision,
      });
      if (!alive.current || mine !== request.current) return;
      if (
        result.kind !== "collectionRevoked" ||
        result.publicationId !== publication.publicationId ||
        result.authorityRevision !== publication.authorityRevision + 1
      )
        throw new Error("dohc could not confirm Collection access was revoked.");
      setPublicationsReload((value) => value + 1);
      setNotice(
        "App Collection access revoked. Prepare the app again to review and restore access.",
      );
    } catch (cause) {
      if (alive.current && mine === request.current) {
        setError(
          ipcErrorMessage(cause, "dohc could not confirm that Collection access was revoked."),
        );
        setPublicationsReload((value) => value + 1);
      }
    } finally {
      if (alive.current && mine === request.current) {
        setBusy(null);
        setBusyPublicationId(null);
      }
    }
  };

  const back = () => {
    cancel(candidate.current);
    candidate.current = null;
    setPrepared(null);
    setError(null);
  };
  const closeWithdrawal = () => {
    setPendingWithdraw(null);
    heading.current?.focus();
  };
  const closeRevocation = () => {
    setPendingRevoke(null);
    heading.current?.focus();
  };

  const preparedOperationIds = (prepared?.capabilities ?? []).flatMap((capability) =>
    capability.kind === "dataset" ? capability.operationIds : [],
  );
  const linkReadChoice: LinkReadChoice = {
    selected: new Set(linkReads.map((read) => read.operationId)),
    shared: new Set(
      preparedOperationIds.filter((id, index) => preparedOperationIds.indexOf(id) !== index),
    ),
    disabled: !!busy,
    onChange: (operation, checked) =>
      setLinkReads((previous) =>
        checked
          ? [
              ...previous,
              {
                operationId: operation.operationId,
                fieldIds: operation.fields!.map((field) => field.fieldId),
              },
            ]
          : previous.filter((read) => read.operationId !== operation.operationId),
      ),
  };

  const localView = view === "local" && !prepared;
  // A candidate under review lists the files Approve changes binds; the source check's list is the fallback.
  const paths = localView
    ? (staged?.sourcePaths ??
      (needsCandidate ? localCandidate?.sourcePaths : undefined) ??
      review?.source?.sourcePaths)
    : undefined;
  const shown = (path: string) =>
    path.startsWith(`${props.appRoot}/`) ? path.slice(props.appRoot.length + 1) : path;
  const boxCapabilities = !review
    ? null
    : staged
      ? staged.capabilities
      : !needsCandidate && approval
        ? approvedCapabilities(approval)
        : (localCandidate?.capabilities ?? null);
  const boxExternal = staged
    ? null
    : !needsCandidate && approval
      ? (approval.external ?? null)
      : (localCandidate?.external ?? null);
  const approving = busy === "approve" || candidateState === "loading";
  const canApprove = !!localCandidate && candidateState === "idle" && !busy && !responsesBusy;
  // Share links show once the server returns this app's publications. It stays hidden when the workspace is not synced,
  // the server does not publish apps here, or the sync status reports the server unreachable. Any other failure keeps
  // the label with one line and Try again, which stays while it reloads. Publishing on a link never needs approval here.
  const publicationAppUrl = (publication: Publication): string | null => {
    if (
      publication.manifestUnavailable ||
      publication.appRoot !== props.appRoot ||
      !publication.active ||
      publication.operatorTakedown ||
      !publication.linkCurrent
    )
      return null;
    const match = links.find(
      (link) => link.shareId === publication.shareId && link.grantId === publication.grantId,
    );
    return appLinkUrl(match?.url, publication.publicationId);
  };
  const linkRows = publications.filter(
    (publication) => publication.active || publication.operatorTakedown,
  );
  const showLinks =
    !!review && synced === true && !linksHidden && (!publicationsLoading || linksFailed);
  const connect = props.access?.context.connect;
  const server = props.access?.server ?? null;
  const status = (
    <>
      {responsesBusy ? (
        <p role="status" className="m-0 text-[13px] text-muted">
          Updating responses. Wait before closing.
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="m-0 text-[13px] text-ink">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </>
  );

  return (
    <>
      <Overlay onClose={committing ? undefined : props.onClose}>
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="app-publication-title"
          data-testid="app-publication-dialog"
          className="dohc-elevated flex max-h-[calc(100vh-128px)] w-[min(520px,calc(100vw-32px))] flex-col gap-6 overflow-y-auto rounded-xl border border-line bg-panel p-6 text-left"
        >
          {/* The title, then Close, then the files toggle, so Tab follows the header the way it reads. */}
          <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3">
            <span className="row-span-2 grid size-9 place-items-center rounded-lg bg-panel-2 text-muted">
              <AppWindow size={18} aria-hidden />
            </span>
            <h2
              ref={heading}
              tabIndex={-1}
              id="app-publication-title"
              className="m-0 truncate text-base font-semibold text-ink"
              title={title}
            >
              {title}
            </h2>
            <IconButton aria-label="Close" disabled={committing} onClick={props.onClose}>
              <X size={14} aria-hidden />
            </IconButton>
            <div className="col-span-2 col-start-2 mt-1 flex min-w-0 items-center gap-2 text-[12px] text-muted">
              <span className="min-w-0 truncate" title={props.appRoot}>
                {props.appRoot.split("/").pop() || props.appRoot}
              </span>
              {paths ? (
                <>
                  <span aria-hidden>·</span>
                  <button
                    type="button"
                    aria-expanded={filesOpen}
                    aria-controls={filesId}
                    onClick={() => setFilesOpen((value) => !value)}
                    className="inline-flex shrink-0 items-center gap-1 rounded text-muted hover:text-ink"
                  >
                    {paths.length === 1 ? "1 file" : `${paths.length} files`}
                    {filesOpen ? (
                      <ChevronDown size={12} aria-hidden />
                    ) : (
                      <ChevronRight size={12} aria-hidden />
                    )}
                  </button>
                </>
              ) : null}
            </div>
            {paths && filesOpen ? (
              <ul
                id={filesId}
                data-testid="app-publication-source-paths"
                className="col-span-2 col-start-2 m-0 mt-2 flex list-none flex-col gap-1 p-0 text-[12px] text-muted"
              >
                {paths.map((path) => (
                  <li key={path} className="truncate" title={path}>
                    {shown(path)}
                  </li>
                ))}
              </ul>
            ) : null}
          </header>
          {localView && staged ? (
            <div data-testid="staged-app-review-card" className="flex flex-col gap-4">
              <StateLine icon={CircleDashed} tone="text-muted" text={stagedStateHeading(staged)}>
                <More>Approving applies these Collection rules and approves this app.</More>
              </StateLine>
              <StagedCollectionsBox collections={staged.collections} />
              {staged.likelySecrets.length > 0 ? (
                <LikelySecretsWarning secrets={staged.likelySecrets} />
              ) : null}
              <AppAccessSummary
                capabilities={staged.capabilities}
                approved={approval ? approvedCapabilities(approval) : null}
                failed={false}
                onRetry={() => setLocalReload((value) => value + 1)}
              />
              {status}
              <div className="sticky -bottom-6 -mx-6 -mb-6 flex flex-col gap-2 border-t border-line bg-panel px-6 py-4">
                {approveFailed !== null ? (
                  <p
                    role="alert"
                    title={approveFailed}
                    className="m-0 text-right text-[13px] text-danger"
                  >
                    {approveFailed}
                  </p>
                ) : null}
                <footer className="flex items-center gap-2">
                  <SecondaryButton
                    data-testid="staged-app-discard"
                    disabled={!!busy || responsesBusy}
                    aria-busy={busy === "withdraw"}
                    onClick={() => void discardStaged(staged)}
                  >
                    {busy === "withdraw" ? "Discarding…" : "Discard"}
                  </SecondaryButton>
                  <span className="flex-1" />
                  <SecondaryButton disabled={committing} onClick={props.onClose}>
                    Cancel
                  </SecondaryButton>
                  <PrimaryButton
                    data-testid="staged-app-approve"
                    aria-busy={busy === "approve"}
                    disabled={!!busy || responsesBusy}
                    onClick={() => void approveStaged(staged)}
                  >
                    {busy === "approve" ? "Approving…" : "Approve and open"}
                  </PrimaryButton>
                </footer>
              </div>
            </div>
          ) : localView ? (
            <>
              {!review ? (
                <div aria-hidden className="invisible text-[13px]">
                  <p className="m-0">.</p>
                </div>
              ) : approval && !changed ? (
                <StateLine
                  icon={CircleCheck}
                  tone={approval.active ? "text-success" : "text-muted"}
                  text="Approved on this device"
                >
                  {approval.active ? null : <More>Inactive on this device</More>}
                </StateLine>
              ) : approval ? (
                <StateLine
                  icon={TriangleAlert}
                  tone="text-warning"
                  text="The app's source changed since you approved it."
                >
                  <More>The app runs the approved version until you approve the changes.</More>
                </StateLine>
              ) : (
                <StateLine
                  icon={CircleDashed}
                  tone="text-muted"
                  text="Approve this app to run it on this device."
                >
                  <More>Later source edits wait for your approval.</More>
                </StateLine>
              )}
              {review?.rows
                .filter((row) => !row.approved)
                .map((row) =>
                  "pendingCreates" in row ? (
                    row.pendingCreates > 0 ? (
                      <div
                        key={row.publicationId}
                        className="flex items-center gap-2 text-[12px] text-warning"
                      >
                        <p className="m-0 flex-1">{unconfirmedResponses(row.pendingCreates)}</p>
                        <SecondaryButton
                          size="row"
                          disabled={!!busy || responsesBusy}
                          onClick={() => void withdraw(row, true)}
                        >
                          Try again
                        </SecondaryButton>
                      </div>
                    ) : null
                  ) : "datasetCapability" in row || "datasetCapabilities" in row ? (
                    <p key={row.publicationId} className="m-0 text-[12px] text-warning">
                      This app's data is not active here. If you moved it to a share link, open that
                      publication.
                    </p>
                  ) : null,
                )}
              {needsCandidate && localCandidate?.likelySecrets.length ? (
                <LikelySecretsWarning secrets={localCandidate.likelySecrets} />
              ) : null}
              <AppAccessSummary
                capabilities={boxCapabilities}
                approved={changed && approval ? approvedCapabilities(approval) : null}
                external={boxExternal}
                approvedExternal={changed && approval ? (approval.external ?? null) : null}
                failed={localReview.status === "failed" || candidateState === "failed"}
                onRetry={() =>
                  localReview.status === "failed"
                    ? setLocalReload((value) => value + 1)
                    : retryPreparation()
                }
              />
              {showLinks ? (
                <section aria-labelledby="app-links-title">
                  <h3 id="app-links-title" className="m-0 mb-2 text-[13px] font-medium text-ink">
                    Share links
                  </h3>
                  {linksSignedOut && connect ? (
                    <div
                      data-testid="app-links-signed-out"
                      data-reason="signed-out"
                      className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-[13px]"
                    >
                      <LogIn size={12} aria-hidden className="shrink-0 text-muted" />
                      <p className="m-0 min-w-0 flex-1 truncate text-ink">
                        Not connected to{" "}
                        {server === null ? (
                          "this workspace's server"
                        ) : (
                          <span className="font-medium" title={server}>
                            {serverName(server)}
                          </span>
                        )}
                      </p>
                      {/* Connect server opens its own place, so the dialog closes first. */}
                      <SecondaryButton
                        size="compact"
                        disabled={committing}
                        onClick={() => {
                          props.onClose();
                          connect();
                        }}
                      >
                        Connect server
                      </SecondaryButton>
                    </div>
                  ) : linksFailed ? (
                    <div
                      data-testid="app-links-failed"
                      className="flex items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-[13px]"
                    >
                      <TriangleAlert size={12} aria-hidden className="shrink-0 text-danger" />
                      <p
                        className="m-0 min-w-0 flex-1 text-ink"
                        title={publicationsError ?? undefined}
                      >
                        The server did not return this app's links.
                      </p>
                      <SecondaryButton
                        size="row"
                        aria-busy={publicationsLoading}
                        onClick={() => {
                          if (!publicationsLoading) setPublicationsReload((value) => value + 1);
                        }}
                      >
                        Try again
                      </SecondaryButton>
                    </div>
                  ) : (
                    <ul className="m-0 list-none divide-y divide-line rounded-lg border border-line bg-bg p-0">
                      {linkRows.map((publication) => {
                        const directAppUrl = publicationAppUrl(publication);
                        return (
                          <li
                            key={publication.publicationId}
                            className="flex items-center gap-2 px-3 py-2 text-[13px]"
                          >
                            {publication.audience === "workspace" ? (
                              <Users size={12} aria-hidden className="shrink-0 text-muted" />
                            ) : (
                              <LinkIcon size={12} aria-hidden className="shrink-0 text-muted" />
                            )}
                            <span
                              className={`min-w-0 flex-1 truncate ${publication.operatorTakedown || !publication.linkCurrent ? "text-warning" : "text-ink"}`}
                            >
                              {publication.operatorTakedown
                                ? "Disabled by server operator"
                                : !publication.linkCurrent
                                  ? "Link changed"
                                  : publication.audience === "workspace"
                                    ? "Published for workspace members"
                                    : "Published on a share link"}
                            </span>
                            <span className="shrink-0 text-[12px] text-muted">
                              {publication.grantId
                                ? `Link ${publication.grantId.slice(0, 8)}`
                                : MEMBERS_LABEL}
                            </span>
                            {directAppUrl ? (
                              <CopyButton
                                key={directAppUrl}
                                size="row"
                                label="Copy app link"
                                sensitive={APP_LINK_SECRET}
                                disabled={!!busy || responsesBusy}
                                getText={() => directAppUrl}
                              />
                            ) : null}
                            {publication.active && !publication.operatorTakedown ? (
                              <SecondaryButton
                                size="row"
                                disabled={!!busy || responsesBusy}
                                aria-label={`Unpublish ${publication.publicationId}`}
                                onClick={() => setPendingWithdraw(publication)}
                              >
                                {busy === "withdraw" &&
                                busyPublicationId === publication.publicationId
                                  ? "Unpublishing…"
                                  : "Unpublish"}
                              </SecondaryButton>
                            ) : null}
                          </li>
                        );
                      })}
                      <li className="flex items-center gap-2 px-3 py-2 text-[13px]">
                        {linkRows.length === 0 ? (
                          <>
                            <LinkIcon size={12} aria-hidden className="shrink-0 text-muted" />
                            <span className="flex-1 text-muted">Not on a link</span>
                          </>
                        ) : (
                          <span className="flex-1" />
                        )}
                        <SecondaryButton
                          size="row"
                          disabled={!!busy || responsesBusy}
                          onClick={() => {
                            setError(null);
                            setNotice(null);
                            setView("links");
                          }}
                        >
                          Publish on a link
                        </SecondaryButton>
                      </li>
                    </ul>
                  )}
                </section>
              ) : null}
              {status}
              {/* A failed action shows right above the button that retries it, so the two stay one part. */}
              <div className="flex flex-col gap-2">
                {approveFailed !== null ? (
                  <p
                    role="alert"
                    title={approveFailed}
                    className="m-0 text-right text-[13px] text-danger"
                  >
                    dohc could not approve this app. Try again.
                  </p>
                ) : null}
                {openFailed !== null && approval?.active && !changed ? (
                  <p
                    role="alert"
                    title={openFailed}
                    className="m-0 text-right text-[13px] text-danger"
                  >
                    dohc could not open this app in your browser. Try again.
                  </p>
                ) : null}
                <footer className="flex items-center gap-2">
                  {approval ? (
                    <SecondaryButton
                      disabled={!!busy || responsesBusy}
                      aria-busy={
                        busy === "withdraw" && busyPublicationId === approval.publicationId
                      }
                      onClick={() => void withdraw(approval, true)}
                    >
                      Remove approval
                    </SecondaryButton>
                  ) : null}
                  <span className="flex-1" />
                  {approval && !changed ? (
                    <>
                      {/* An inactive approval can only fail to open, and the state line already says it is inactive. */}
                      {approval.active ? (
                        <SecondaryButton
                          disabled={!!busy || responsesBusy}
                          aria-busy={busy === "open"}
                          onClick={() => void openInBrowser(approval.publicationId)}
                        >
                          Open in browser
                        </SecondaryButton>
                      ) : null}
                      <PrimaryButton disabled={committing} onClick={props.onClose}>
                        Done
                      </PrimaryButton>
                    </>
                  ) : (
                    <>
                      <SecondaryButton disabled={committing} onClick={props.onClose}>
                        Cancel
                      </SecondaryButton>
                      <PrimaryButton
                        data-testid="app-publication-approve"
                        aria-busy={localReview.status === "loading" || approving}
                        disabled={!review || !canApprove}
                        onClick={() => void approveLocal()}
                      >
                        {approval ? "Approve changes" : "Approve and open"}
                      </PrimaryButton>
                    </>
                  )}
                </footer>
              </div>
            </>
          ) : prepared ? (
            <>
              {status}
              <h3
                ref={reviewHeading}
                tabIndex={-1}
                className="m-0 text-[13px] font-medium text-ink"
              >
                Review app publication
              </h3>
              <p className="m-0 text-[13px] text-ink">
                {reactivating
                  ? "Republish this stored revision. It does not include later source edits."
                  : "Publish this captured app. Later source edits need a new publication."}
              </p>
              <div className="text-[12px] text-muted">
                <span className="font-medium text-ink">
                  {preparedForMembers ? "Who can open it" : "Link"}
                </span>
                <p className="m-0 break-words">{preparedLink}</p>
              </div>
              <div>
                <h3 className="m-0 text-[13px] font-medium text-ink">Files included</h3>
                {prepared.likelySecrets.length > 0 ? (
                  <LikelySecretsWarning secrets={prepared.likelySecrets} />
                ) : null}
                <ul
                  data-testid="app-publication-source-paths"
                  className="mb-0 mt-2 max-h-40 list-none overflow-y-auto rounded-md border border-line bg-bg p-2 text-[12px] text-muted"
                >
                  {prepared.sourcePaths.map((path) => (
                    <li key={path} className="break-all">
                      {path}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-3 text-[13px] text-muted">
                <h3 className="m-0 text-[13px] font-medium text-ink">Workspace data access</h3>
                {prepared.capabilities.length === 0 ? (
                  <p className="m-0 rounded-lg border border-line bg-bg px-3 py-2 text-[13px] text-muted">
                    No workspace data
                  </p>
                ) : (
                  prepared.capabilities.map((capability) =>
                    capability.kind === "dataset" ? (
                      <DatasetPermissionCard
                        reportError={reportError}
                        workspaceId={props.workspaceId}
                        key={collectionKey(prepared.approvalId, capability.datasetId)}
                        capability={capability}
                        {...(reactivating || preparedForMembers ? {} : { linkReadChoice })}
                      />
                    ) : (
                      <CollectionPermissionCard
                        key={capability.collectionPath}
                        capability={capability}
                      />
                    ),
                  )
                )}
                <ExternalNetworkCard
                  sharedCollectionFiles={prepared.capabilities.some(
                    (capability) => capability.kind === "collection-create",
                  )}
                />
              </div>
              <details className="text-[12px] text-muted">
                <summary className="cursor-pointer">Publication revision</summary>
                <dl className="space-y-2 font-mono">
                  <div>
                    <dt>Version</dt>
                    <dd className="m-0 break-all">{prepared.versionId}</dd>
                  </div>
                  <div>
                    <dt>Source</dt>
                    <dd className="m-0 break-all">{prepared.sourceRevision}</dd>
                  </div>
                  <div>
                    <dt>Publication</dt>
                    <dd data-testid="app-publication-digest" className="m-0 break-all">
                      {prepared.candidateDigest}
                    </dd>
                  </div>
                </dl>
              </details>
              <footer className="flex justify-end gap-2">
                <SecondaryButton disabled={!!busy || responsesBusy} onClick={back}>
                  Back
                </SecondaryButton>
                <PrimaryButton
                  data-testid="app-publication-approve"
                  disabled={!!busy || responsesBusy}
                  onClick={() => void approve()}
                >
                  {busy === "approve"
                    ? "Publishing…"
                    : reactivating
                      ? "Republish this revision"
                      : "Publish this revision"}
                </PrimaryButton>
              </footer>
            </>
          ) : (
            <>
              {status}
              {synced === false ? null : (
                <div className="border-b border-line pb-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="m-0 text-[13px] font-medium text-ink">Publications</h3>
                    <SecondaryButton
                      disabled={publicationsLoading || !!busy || responsesBusy}
                      onClick={() => setPublicationsReload((value) => value + 1)}
                    >
                      Reload publications
                    </SecondaryButton>
                  </div>
                  {publicationsLoading || synced === null ? (
                    <SkeletonRows rows={2} label="Loading publications…" className="mt-3" />
                  ) : publicationsError ? (
                    <p role="alert" className="mb-0 text-[13px] text-danger">
                      {publicationsError}
                    </p>
                  ) : publications.length === 0 ? (
                    <p className="mb-0 text-[12px] text-muted">No publications.</p>
                  ) : (
                    <ul className="m-0 mt-3 list-none space-y-3 p-0">
                      {publications.map((publication) => {
                        const directAppUrl = publicationAppUrl(publication);
                        return (
                          <li
                            key={publication.publicationId}
                            className="flex items-center justify-between gap-3"
                          >
                            <div className="min-w-0 text-[12px] text-muted">
                              <p className="m-0 break-all">
                                {publication.grantId
                                  ? `Link ${publication.grantId.slice(0, 8)}`
                                  : MEMBERS_LABEL}{" "}
                                ·{" "}
                                {publication.operatorTakedown
                                  ? "Disabled by server operator"
                                  : !publication.linkCurrent
                                    ? "Link changed"
                                    : publication.active
                                      ? "Published"
                                      : "Unpublished"}
                              </p>
                              {publication.operatorTakedown ? (
                                <>
                                  <p className="m-0 break-words whitespace-pre-wrap text-warning">
                                    {publication.operatorTakedown.reason}
                                  </p>
                                  <p className="m-0">
                                    Contact the server operator about this publication.
                                  </p>
                                </>
                              ) : null}
                              {!publication.operatorTakedown && !publication.linkCurrent ? (
                                <p className="m-0 text-warning">
                                  This publication is unavailable. Choose a current link below and
                                  review the app again.
                                </p>
                              ) : null}
                              {publication.manifestUnavailable ? (
                                <>
                                  <p className="m-0 text-warning">
                                    Source details unavailable. This publication may belong to
                                    another app.
                                  </p>
                                  <p className="m-0 break-all font-mono">
                                    {publication.publicationId}
                                  </p>
                                </>
                              ) : (
                                <p
                                  className="m-0 truncate font-mono"
                                  title={publication.sourceRevision}
                                >
                                  Source {publication.sourceRevision.slice(0, 12)}
                                </p>
                              )}
                              {publication.collectionCapability === "unavailable" ? (
                                <p className="mb-0 mt-1 text-warning">
                                  Collection access details unavailable. You can still revoke
                                  access.
                                </p>
                              ) : publication.collectionCapability ? (
                                <details className="mt-1">
                                  <summary className="cursor-pointer">
                                    Approved Collection access
                                  </summary>
                                  <div className="mt-2">
                                    <CollectionPermissionCard
                                      capability={publication.collectionCapability}
                                      compact
                                    />
                                  </div>
                                </details>
                              ) : publication.datasetCapabilities.length ? null : (
                                <p className="mb-0 mt-1">No Collection access</p>
                              )}
                              {publication.datasetCapabilities === "unavailable" ? (
                                <p className="mb-0 mt-1 text-warning">
                                  Collection access details unavailable.
                                </p>
                              ) : (
                                publication.datasetCapabilities.map((capability) => (
                                  <PublishedDatasetDetails
                                    key={capability.datasetId}
                                    reportError={reportError}
                                    workspaceId={props.workspaceId}
                                    capability={capability}
                                  />
                                ))
                              )}
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-2">
                              {directAppUrl ? (
                                <CopyButton
                                  key={directAppUrl}
                                  size="row"
                                  label="Copy app link"
                                  sensitive={APP_LINK_SECRET}
                                  disabled={!!busy || responsesBusy}
                                  getText={() => directAppUrl}
                                />
                              ) : null}
                              {publication.collectionCapability ? (
                                <SecondaryButton
                                  disabled={!!busy || responsesBusy}
                                  aria-label={`Revoke Collection access ${publication.publicationId}`}
                                  onClick={() => setPendingRevoke(publication)}
                                >
                                  {busy === "revokeCollection" &&
                                  busyPublicationId === publication.publicationId
                                    ? "Revoking…"
                                    : "Revoke Collection access"}
                                </SecondaryButton>
                              ) : null}
                              {publication.active ? (
                                <SecondaryButton
                                  disabled={!!busy || responsesBusy}
                                  aria-label={`Unpublish ${publication.publicationId}`}
                                  onClick={() => setPendingWithdraw(publication)}
                                >
                                  {busy === "withdraw" &&
                                  busyPublicationId === publication.publicationId
                                    ? "Unpublishing…"
                                    : "Unpublish"}
                                </SecondaryButton>
                              ) : publication.operatorTakedown ||
                                !publication.linkCurrent ? null : publication.manifestUnavailable ? (
                                <span className="text-[12px] text-muted">Source unavailable</span>
                              ) : (
                                <SecondaryButton
                                  disabled={!!busy || responsesBusy}
                                  onClick={() => void reviewReactivation(publication)}
                                >
                                  {busy === "prepare" &&
                                  busyPublicationId === publication.publicationId
                                    ? "Loading revision…"
                                    : "Review and republish"}
                                </SecondaryButton>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
              {[
                ...new Set(
                  publications
                    .filter(
                      (publication) =>
                        !publication.manifestUnavailable &&
                        publication.collectionCapability &&
                        publication.appRoot === props.appRoot,
                    )
                    .flatMap((publication) => publication.grantId ?? []),
                ),
              ].map((grantId) => (
                <div key={grantId}>
                  <p className="mb-2 mt-0 break-all font-mono text-[12px] text-muted">
                    Link {grantId}
                  </p>
                  <OwnerAppResponses
                    workspaceId={props.workspaceId}
                    grantId={grantId}
                    disabled={publicationsLoading || !!busy}
                    onBusyChange={responseBusyChanged}
                  />
                </div>
              ))}
              <div>
                <h3 className="m-0 text-[13px] font-medium text-ink">Publish this app</h3>
                <p className="mb-0 mt-1 text-[12px] text-muted">
                  {synced === false
                    ? "Sync this workspace to publish this app. Opening on this device does not need sync."
                    : "Publishing needs a connection to your dohc server. Approval for this device does not."}
                </p>
              </div>
              {synced === false ? null : (
                <>
                  <label className="text-[13px] text-ink">
                    Who can open it
                    <select
                      aria-label="Publication share link"
                      disabled={loading || !!busy || responsesBusy}
                      value={selected}
                      onChange={(event) => setSelected(event.target.value)}
                      className="mt-2 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink focus:border-ink"
                    >
                      <option value="">Choose who can open it</option>
                      <option value={MEMBERS}>{MEMBERS_LABEL}</option>
                      {links.map((link) => (
                        <option key={link.grantId} value={link.grantId}>
                          {linkLabel(link)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {loading || synced === null ? (
                    <SkeletonRows rows={2} label="Loading links…" />
                  ) : loadError ? (
                    <div>
                      <p role="alert" className="text-[13px] text-danger">
                        {loadError}
                      </p>
                      <SecondaryButton onClick={() => setReload((value) => value + 1)}>
                        Reload links
                      </SecondaryButton>
                    </div>
                  ) : links.length === 0 ? (
                    <p className="m-0 text-[13px] text-muted">
                      No active links include this app's source folder.
                    </p>
                  ) : null}
                </>
              )}
              {props.onShareSource ? (
                <div className="flex items-center justify-between gap-3">
                  <p className="m-0 text-[12px] text-muted">
                    Create a link that includes this app's source files.
                  </p>
                  <SecondaryButton
                    disabled={!!busy || responsesBusy}
                    onClick={() => {
                      props.onClose();
                      props.onShareSource?.();
                    }}
                  >
                    Share app folder
                  </SecondaryButton>
                </div>
              ) : null}
              {synced === false ? null : (
                <p className="m-0 text-[13px] text-muted">
                  Review this app's source and data access before publishing.
                </p>
              )}
              <footer className="flex justify-end gap-2">
                {props.localApproval ? (
                  <SecondaryButton
                    disabled={committing}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setView("local");
                    }}
                  >
                    Back
                  </SecondaryButton>
                ) : (
                  <SecondaryButton disabled={committing} onClick={props.onClose}>
                    Cancel
                  </SecondaryButton>
                )}
                {synced === false ? null : (
                  <PrimaryButton
                    disabled={
                      !!busy ||
                      responsesBusy ||
                      (selected !== MEMBERS && (!selectedLink || loading || !!loadError))
                    }
                    onClick={() => void prepare()}
                  >
                    {busy === "prepare" && !busyPublicationId ? "Preparing app…" : "Prepare app"}
                  </PrimaryButton>
                )}
              </footer>
            </>
          )}
        </section>
      </Overlay>
      {pendingRevoke ? (
        <ConfirmDialog
          intent="danger"
          icon={Unlink}
          testId="app-collection-revoke-confirm"
          cancelTestId="app-collection-revoke-cancel"
          confirmTestId="app-collection-revoke-action"
          title="Revoke Collection access?"
          confirmLabel="Revoke access"
          onCancel={closeRevocation}
          onConfirm={() => {
            const value = pendingRevoke;
            closeRevocation();
            void revokeCollection(value);
          }}
        >
          <p>
            The app stays published, but it can no longer read the Collection or accept responses
            through dohc. Saved responses stay in your workspace, and copies already received cannot
            be removed.
          </p>
          {pendingRevoke.manifestUnavailable ? (
            <p className="text-warning">
              Source details are unavailable. This publication may belong to another app.
            </p>
          ) : null}
          <p className="break-all font-mono text-[12px]">{pendingRevoke.publicationId}</p>
        </ConfirmDialog>
      ) : null}
      {pendingWithdraw ? (
        <ConfirmDialog
          intent="danger"
          icon={EyeOff}
          testId="app-publication-withdraw-confirm"
          cancelTestId="app-publication-withdraw-cancel"
          confirmTestId="app-publication-withdraw-confirm-action"
          title="Unpublish this app?"
          confirmLabel="Unpublish app"
          onCancel={closeWithdrawal}
          onConfirm={() => {
            const value = pendingWithdraw;
            closeWithdrawal();
            void withdraw(value);
          }}
        >
          <p>This stops new access through dohc. It cannot remove copies sent elsewhere.</p>
          <p>
            {!pendingWithdraw.linkCurrent
              ? "This publication belongs to a changed link. Choose a current link to publish the app again."
              : pendingWithdraw.manifestUnavailable
                ? "Source details are unavailable. This publication may belong to another app and cannot be republished."
                : "You can review this stored revision and publish it again."}
          </p>
          <p
            className={`break-all text-[12px] ${pendingWithdraw.manifestUnavailable ? "font-mono" : ""}`}
          >
            {pendingWithdraw.manifestUnavailable
              ? pendingWithdraw.publicationId
              : pendingWithdraw.appRoot}
          </p>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
