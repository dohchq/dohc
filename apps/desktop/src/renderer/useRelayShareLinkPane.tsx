import { withErrorWords } from "../ipc/errorWords";
import { ipcErrorMessage } from "./ipcError";
import { ChevronRight, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { normalizeShareDiscussionBody } from "@dohc/security-contract/share-discussion";
import { shareAccessRank } from "@dohc/security-contract/share-selector";
import type {
  CreateRelayShareLinkPayload,
  RelayShareDiscussionMessage,
  RelayShareLinkDependent,
  RelayShareLinkIndependentGrant,
  RelayShareLinkRow,
} from "../ipc/bridgeContract";
import type { RelayShareTarget } from "./RelayShareDialog";
import { bridge } from "./bridge";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import {
  AutomationShareNote,
  useAutomationShareCheck,
  type AutomationShare,
} from "./automationShareCheck";
import {
  DangerButton,
  GhostButton,
  IconButton,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
} from "./ui/controls";
import { MENU_SEPARATOR, type MenuEntry } from "./ui/Menu";
import { CopyButton, useCopy, type CopySecret } from "./ui/CopyButton";
import { agentLinkSetups } from "./agentLinkApps";
import {
  AGENT_ADDRESS_SECRET,
  LinkAgentsList,
  agentAddressFor,
  useLinkAgentDisconnects,
} from "./shareLinkAgents";
import {
  SHARE_ACCESS_DESCRIPTIONS,
  SHARE_ACCESS_WORDS,
  SHARE_ROW_INSET,
  ShareAccessLevel,
  ShareAccessMenu,
  ShareLinkRow,
  ShareOptionsMenu,
  SharePersonRow,
} from "./shareAccess";
import {
  isShareAccess,
  PersonAccessRow,
  PersonRemovalError,
  removePersonAccess,
  type AnsweredPerson,
  type ListedPerson,
} from "./sharePerson";
import { SkeletonRows } from "./ui/SkeletonRows";

// The relay keeps a sealed copy of each link for its owner, so Share can
// copy the same link again.
const SHARE_LINK_SECRET: CopySecret = {
  what: "the share link",
  again: "Open Share to copy it again.",
};

type LinkAccess = "view" | "comment" | "edit";

export function linkRetuneLabels(
  widens: boolean,
  access: LinkAccess | undefined,
  previous: string | undefined,
) {
  if (access === "edit") return { action: "Turn on editing", pending: "Turning on editing…" };
  if (widens) return { action: "Turn on comments", pending: "Turning on comments…" };
  if (access === "view" && previous === "edit")
    return { action: "Turn off editing", pending: "Turning off editing…" };
  return access === "comment"
    ? { action: "Use Comment access", pending: "Changing access…" }
    : { action: "Turn off comments", pending: "Turning off comments…" };
}

type LinkConfirmation =
  | {
      kind: "reset";
      shareId: string;
      grantId: string;
    }
  | {
      kind: "end";
      shareId: string;
      grantId: string;
    }
  | {
      kind: "retune";
      shareId: string;
      grantId: string;
      access: LinkAccess;
    };

type LinkMutationBusy = {
  kind: LinkConfirmation["kind"];
  grantId: string;
};

type LinkRequestBusy =
  | { kind: "create" }
  | { kind: "add"; shareId: string }
  // Asking which automations an Edit link would stop; no shareId for a new link.
  | { kind: "check"; shareId: string | null };

type MintedLinkResult = {
  grantId: string;
  url: string;
};

type MintedLink = MintedLinkResult & { access: LinkAccess | null };

type LinkGroup = {
  shareId: string;
  rows: RelayShareLinkRow[];
};

type OwnerAppendIntent = {
  body: string;
  idempotencyKey: string;
};

type OwnerDiscussionState = {
  expanded: boolean;
  loaded: boolean;
  loading: boolean;
  paging: boolean;
  reconciliationPending: boolean;
  activityRevision: number | null;
  linkCommentsPaused: boolean;
  messages: RelayShareDiscussionMessage[];
  nextCursor: string | null;
  loadError: boolean;
  failedReadCursor: string | null;
  draft: string;
  appendIntent: OwnerAppendIntent | null;
  appendError: boolean;
};

type OwnerActivityControl = {
  workspaceId: string;
  shareId: string;
  scopeGeneration: number;
  generation: number;
  revision: number;
  principalBlockedById: Map<string, boolean>;
  nextHold: number;
  retryAttempt: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  pollId: string | null;
};

type OwnerMutationBusy = {
  shareId: string;
  actionKey: string;
};

type OwnerMutationError = OwnerMutationBusy & { message?: string };

type OwnerRemoval = { message: string; retry: () => void };

const OWNER_DISCUSSION_ACTIVITY_HOLD_MS = 30_000;
const OWNER_DISCUSSION_ACTIVITY_LIMIT = 100;
const OWNER_DISCUSSION_ACTIVITY_RETRY_BASE_MS = 250;
const OWNER_DISCUSSION_ACTIVITY_RETRY_MAX_MS = 5_000;

type OwnerConfirmation =
  | { kind: "delete"; shareId: string; messageId: string }
  | {
      kind: "block";
      shareId: string;
      principalId: string;
      name: string;
    }
  | {
      kind: "promote";
      shareId: string;
      grantId: string;
      parentGrantId: string;
      parentGeneration: number;
      name: string;
    }
  | {
      kind: "revoke";
      shareId: string;
      grantId: string;
      name: string;
    };

function newLinkReach(target: RelayShareTarget): string {
  const reach =
    target.kind === "version"
      ? "The link shows this version as it is now."
      : "The link includes files added later.";
  return `${reach} The sync relay can read this content.`;
}

const LINKS_BUSY = "Wait for the current change to finish.";
const waits = (busy: boolean) => (busy ? { disabled: true, description: LINKS_BUSY } : {});

function normalizedPathSet(paths: readonly string[]): string[] {
  const normalized = paths.map((path) => {
    const segments: string[] = [];
    for (const segment of path.replaceAll("\\", "/").split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
    }
    return segments.join("/");
  });
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizedPathSet(left);
  const normalizedRight = normalizedPathSet(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((path, index) => path === normalizedRight[index])
  );
}

function targetKeyOf(target: RelayShareTarget): string {
  return target.kind === "version"
    ? JSON.stringify(["version", target.versionId])
    : JSON.stringify(["paths", ...normalizedPathSet(target.paths)]);
}

/** One workspace's shares of one selection: what Share reads, and what its pending work belongs to. */
export function shareScope(workspaceId: string, target: RelayShareTarget): string {
  return JSON.stringify([workspaceId, targetKeyOf(target)]);
}

// The selection as the dialog names it, for notices about its shares.
export function targetLabel(target: RelayShareTarget): string {
  return target.kind === "version"
    ? `version "${target.versionName ?? target.versionId}"`
    : (target.label ?? target.paths.join(", "));
}

// Whether a share is of exactly what the dialog shares: the same version, or
// the same set of paths.
export function rowMatchesTarget(
  row: Pick<RelayShareLinkRow, "selector">,
  target: RelayShareTarget,
): boolean {
  if (row.selector === null) return false;
  return target.kind === "version"
    ? row.selector.versionId === target.versionId
    : row.selector.versionId === null && pathsEqual(row.selector.paths, target.paths);
}

function dependentGrantIds(row: RelayShareLinkRow): string[] {
  return row.dependents
    .map((dependent) => dependent.grantId)
    .sort((left, right) => left.localeCompare(right));
}

function groupLinksByShareId(rows: RelayShareLinkRow[]): LinkGroup[] {
  const groups: LinkGroup[] = [];
  const byShareId = new Map<string, LinkGroup>();
  for (const row of rows) {
    const existing = byShareId.get(row.shareId);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    const group = { shareId: row.shareId, rows: [row] };
    byShareId.set(row.shareId, group);
    groups.push(group);
  }
  return groups;
}

function emptyOwnerDiscussion(): OwnerDiscussionState {
  return {
    expanded: false,
    loaded: false,
    loading: false,
    paging: false,
    reconciliationPending: false,
    activityRevision: null,
    linkCommentsPaused: false,
    messages: [],
    nextCursor: null,
    loadError: false,
    failedReadCursor: null,
    draft: "",
    appendIntent: null,
    appendError: false,
  };
}

function mergeDiscussionMessages(
  current: RelayShareDiscussionMessage[],
  incoming: RelayShareDiscussionMessage[],
): RelayShareDiscussionMessage[] | null {
  const merged = [...current];
  const byId = new Map(merged.map((message) => [message.messageId, message] as const));
  for (const message of incoming) {
    const existing = byId.get(message.messageId);
    if (existing === undefined) {
      byId.set(message.messageId, message);
      merged.push(message);
      continue;
    }
    if (!sameDiscussionMessageIdentity(existing, message)) return null;
    if (!existing.deleted && !message.deleted && existing.body !== message.body) {
      return null;
    }
    if (existing.deleted && !message.deleted) continue;
    const index = merged.indexOf(existing);
    if (index === -1) return null;
    merged[index] = message;
    byId.set(message.messageId, message);
  }
  return merged.sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs ||
      (left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0),
  );
}

function sameDiscussionMessageIdentity(
  left: RelayShareDiscussionMessage,
  right: RelayShareDiscussionMessage,
): boolean {
  if (
    left.messageId !== right.messageId ||
    left.createdAtMs !== right.createdAtMs ||
    left.author.kind !== right.author.kind ||
    left.author.displayName !== right.author.displayName
  ) {
    return false;
  }
  if (left.author.kind === "named") return right.author.kind === "named";
  return (
    right.author.kind === "link" &&
    "moderation" in left &&
    "moderation" in right &&
    left.author.unverified === right.author.unverified &&
    left.moderation.linkGrantId === right.moderation.linkGrantId &&
    left.moderation.linkPrincipalId === right.moderation.linkPrincipalId
  );
}

function reconcileDiscussionWindowMessages(
  current: RelayShareDiscussionMessage[],
  incoming: RelayShareDiscussionMessage[],
): RelayShareDiscussionMessage[] | null {
  const authoritative = mergeDiscussionMessages([], incoming);
  if (authoritative === null) return null;
  const currentById = new Map(current.map((message) => [message.messageId, message] as const));
  const reconciled: RelayShareDiscussionMessage[] = [];
  for (const message of authoritative) {
    const existing = currentById.get(message.messageId);
    if (existing === undefined) {
      reconciled.push(message);
      continue;
    }
    const merged = mergeDiscussionMessages([existing], [message]);
    if (merged === null || merged.length !== 1) return null;
    reconciled.push(merged[0]!);
  }
  return reconciled;
}

function applyDiscussionPrincipalOverrides(
  messages: RelayShareDiscussionMessage[],
  blockedByPrincipal: ReadonlyMap<string, boolean>,
): RelayShareDiscussionMessage[] {
  if (blockedByPrincipal.size === 0) return messages;
  return messages.map((message) => {
    if (!("moderation" in message)) return message;
    const blocked = blockedByPrincipal.get(message.moderation.linkPrincipalId);
    return blocked === undefined
      ? message
      : {
          ...message,
          moderation: { ...message.moderation, blocked },
        };
  });
}

function namedGrantName(grant: RelayShareLinkIndependentGrant): string {
  return grant.recipientEmail ?? grant.recipientUserId ?? "Unnamed person";
}

function dependentName(dependent: RelayShareLinkDependent): string {
  return dependent.recipientEmail ?? dependent.recipientUserId ?? "Unnamed person";
}

const isActive = (row: RelayShareLinkRow) => row.status === "active";

function isDiscussionMutationAction(actionKey: string): boolean {
  return (
    actionKey === "pause" || actionKey.startsWith("delete:") || actionKey.startsWith("principal:")
  );
}

function isGrantMutationAction(actionKey: string): boolean {
  return actionKey.startsWith("promote:") || actionKey.startsWith("revoke:");
}

const shortDate = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
const shortTimestamp = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "short",
});

function DependentNames({ dependents }: { dependents: RelayShareLinkDependent[] }) {
  return dependents.map((dependent, index) => (
    <span key={dependent.grantId}>
      {index > 0 ? ", " : null}
      {dependent.recipientEmail ?? (
        <code className="font-mono text-[11px] text-ink">{dependent.recipientUserId}</code>
      )}
    </span>
  ));
}

function linkAccessOf(access: string): LinkAccess | null {
  return access === "view" || access === "comment" || access === "edit" ? access : null;
}

function accessWords(access: string): string {
  const known = linkAccessOf(access);
  return known === null ? access : SHARE_ACCESS_WORDS[known];
}

const AGENT_COPY_WORDS = { copied: "Copied for an agent" };
const LINK_ID_COPY_WORDS = { copied: "Copied link ID" };

function LinkRowActions(props: {
  grantId: string;
  url: string | null;
  everyday: readonly MenuEntry[];
  lifecycle: readonly MenuEntry[];
}) {
  const { url } = props;
  const address = url === null ? null : agentAddressFor(url);
  const setups = address === null ? [] : agentLinkSetups(address, "dohc-share");
  const agentCopy = useCopy<string | null>({
    getText: (setupId) =>
      setupId === null ? address : (setups.find((setup) => setup.id === setupId)?.text ?? null),
    words: AGENT_COPY_WORDS,
    sensitive: AGENT_ADDRESS_SECRET,
  });
  const idCopy = useCopy({ getText: () => props.grantId, words: LINK_ID_COPY_WORDS });
  const [lastCopy, setLastCopy] = useState<"agent" | "id">("agent");
  const startedCopies = useRef(0);
  const landedCopy = useRef(0);
  const shown = lastCopy === "id" ? idCopy : agentCopy;
  const copyAs = (kind: "agent" | "id", copied: Promise<void>) => {
    const copy = ++startedCopies.current;
    void copied.then(() => {
      if (copy < landedCopy.current) return;
      landedCopy.current = copy;
      setLastCopy(kind);
    });
  };
  const copyForAgent = (setupId: string | null) => copyAs("agent", agentCopy.copy(setupId));
  const copies: MenuEntry[] = [
    ...(address === null
      ? []
      : [
          {
            id: "agent",
            label: "Copy for an agent",
            testId: "share-link-agent-copy",
            onSelect: () => copyForAgent(null),
          },
          ...setups.map((setup) => ({
            id: `agent-${setup.id}`,
            label: `Copy ${setup.label.charAt(0).toLowerCase()}${setup.label.slice(1)}`,
            testId: `share-link-agent-apps-${setup.id}`,
            onSelect: () => copyForAgent(setup.id),
          })),
        ]),
    {
      id: "link-id",
      label: "Copy link ID",
      testId: "share-link-id-copy",
      onSelect: () => copyAs("id", idCopy.copy()),
    },
  ];
  const items: MenuEntry[] = [props.everyday, copies, props.lifecycle]
    .filter((group) => group.length > 0)
    .flatMap((group, index) => (index === 0 ? group : [MENU_SEPARATOR, ...group]));
  return (
    <>
      <span
        className={`min-w-0 flex-1 truncate text-right text-[12px] ${shown.feedback === "failed" ? "text-danger" : "text-muted"}`}
      >
        {shown.feedback ? shown.words[shown.feedback] : null}
        <span role="status" aria-live="polite" className="sr-only">
          {shown.announcement}
        </span>
      </span>
      {url !== null ? (
        <CopyButton
          size="button"
          label="Copy link"
          getText={() => url}
          sensitive={SHARE_LINK_SECRET}
          testId="share-link-copy"
        />
      ) : null}
      <ShareOptionsMenu
        label="Link options"
        testId={`share-link-options-${props.grantId}`}
        width={240}
        items={items}
      />
    </>
  );
}

const SEPARATE_DRAFT = "share-link-create-section";
const addDraft = (shareId: string) => `share-link-add-${shareId}`;

function personOfGrant(grant: RelayShareLinkIndependentGrant): ListedPerson {
  return {
    shareId: grant.shareId,
    grantId: grant.grantId,
    name: namedGrantName(grant),
    email: grant.recipientEmail,
    access: isShareAccess(grant.access) ? grant.access : null,
    generation: null,
  };
}

export function useRelayShareLinkPane(props: {
  workspaceId: string;
  target: RelayShareTarget;
  // False while sharing cannot work, such as before sync is set up: nothing
  // is read and nothing shows.
  visible: boolean;
  onClose: () => void;
  // Ending a link or a person's access is undoable for a while. The shell
  // shows that notice and holds the Undo, so it outlives this dialog; a
  // refused removal goes to the same shell with Try again.
  shareRemovals?: ShareRemovalNotices;
  // The shell's useDisconnectedLinkAgents set.
  disconnectedAgents?: ReadonlySet<string>;
  // What the dialog knows about the people who no longer depend on a link:
  // their access from the newest of the relay's answers and the Sharing
  // listing, kept by the rule the invited people follow.
  people: {
    answered: (listed: readonly ListedPerson[]) => ListedPerson[];
    changed: (person: AnsweredPerson) => void;
    removed: (grantId: string) => void;
  };
}): {
  content: ReactNode;
  // The people who joined through these links, for the dialog's People list.
  people: ReactNode;
  // The grants of the people `people` lists.
  peopleGrantIds: ReadonlySet<string>;
  close: () => void;
} {
  const agentDisconnects = useLinkAgentDisconnects(props.shareRemovals, props.disconnectedAgents);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkRequestBusy, setLinkRequestBusy] = useState<LinkRequestBusy | null>(null);
  const [supportedLinkAccess, setSupportedLinkAccess] = useState<readonly LinkAccess[]>([
    "view",
    "comment",
  ]);
  const availableLinkAccess =
    props.target.kind === "version"
      ? supportedLinkAccess.filter((access) => access !== "edit")
      : supportedLinkAccess;
  const [linkAccess, setLinkAccess] = useState<LinkAccess>("view");
  const automationCheck = useAutomationShareCheck(props.workspaceId, props.target);
  const newLinkNote = automationCheck.noteFor({ recipientEmail: null, access: linkAccess });
  const [addAccessByShareId, setAddAccessByShareId] = useState<Record<string, LinkAccess>>({});
  const [linkError, setLinkError] = useState<{ message: string; shareId: string | null } | null>(
    null,
  );
  const [linksReadOnce, setLinksReadOnce] = useState(false);
  const [openDetails, setOpenDetails] = useState<ReadonlySet<string>>(() => new Set());
  const [sharesAddingLink, setSharesAddingLink] = useState<ReadonlySet<string>>(() => new Set());
  const [separateOpen, setSeparateOpen] = useState(false);
  // The links past the first share, and a separate link, open from one line.
  const [moreOpen, setMoreOpen] = useState(false);
  // The share whose link shows, kept while it has a working link, and the
  // link of it that shows, kept while it works.
  const shownShareId = useRef<string | null>(null);
  const shownGrantId = useRef<string | null>(null);
  const draftOpeners = useRef(new Map<string, string>());
  // Links whose last change may have landed without its answer: no URL
  // shows for them until the list reads again.
  const [unsureUrls, setUnsureUrls] = useState<ReadonlySet<string>>(() => new Set());
  // Where focus goes once a render has it: a new link's Copy link, or the
  // access of the link just asked for. A new link shows first on its own and
  // then in its row, so its focus follows it there.
  const focusAfterRender = useRef<
    { kind: "copy"; grantId: string; shown: boolean } | { kind: "draft"; testId: string } | null
  >(null);
  useLayoutEffect(() => {
    const target = focusAfterRender.current;
    if (target === null) return;
    if (!props.visible) {
      focusAfterRender.current = null;
      return;
    }
    if (target.kind === "draft") {
      const access = document.querySelector<HTMLElement>(
        `[data-testid=${JSON.stringify(target.testId)}]`,
      );
      if (access) {
        focusAfterRender.current = null;
        access.focus();
      }
      return;
    }
    const boxes = [...document.querySelectorAll<HTMLElement>("[data-link-url-for]")].filter(
      (box) => box.dataset.linkUrlFor === target.grantId,
    );
    const inRow = boxes.find((box) => box.closest("article") !== null);
    const copy = (inRow ?? boxes[0])?.querySelector<HTMLElement>('[data-testid="share-link-copy"]');
    if (!copy) return;
    // Once the link has shown, focus moves only if it was left nowhere.
    const free =
      !target.shown || document.activeElement === null || document.activeElement === document.body;
    if (free && document.activeElement !== copy) copy.focus();
    focusAfterRender.current = inRow ? null : { ...target, shown: true };
  });
  const [minted, setMinted] = useState<MintedLink | null>(null);
  const [links, setLinks] = useState<RelayShareLinkRow[]>([]);
  // A read of the links that changes them reads each link's agents again. A
  // list reads once when it mounts.
  const [linksRevision, setLinksRevision] = useState(0);
  const linksKey = useRef<string | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<LinkConfirmation | null>(null);
  const [mutationBusy, setMutationBusy] = useState<LinkMutationBusy | null>(null);
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);
  const [ownerDiscussionByShareId, setOwnerDiscussionByShareId] = useState<
    Record<string, OwnerDiscussionState>
  >({});
  const [independentGrants, setIndependentGrants] = useState<RelayShareLinkIndependentGrant[]>([]);
  const [ownerAppendBusy, setOwnerAppendBusy] = useState<string | null>(null);
  const [ownerMutationBusy, setOwnerMutationBusy] = useState<OwnerMutationBusy | null>(null);
  const [ownerMutationError, setOwnerMutationError] = useState<OwnerMutationError | null>(null);
  const [ownerConfirmation, setOwnerConfirmation] = useState<OwnerConfirmation | null>(null);
  const linkScopeGeneration = useRef(0);
  const latestMintRequest = useRef(0);
  const latestInventoryRequest = useRef(0);
  const latestMutationRequest = useRef(0);
  const latestDiscussionRequestByShareId = useRef(new Map<string, number>());
  const activeFullDiscussionRequestByShareId = useRef(new Map<string, symbol>());
  const pendingDiscussionReconciliationByShareId = useRef(new Set<string>());
  const latestActivityGenerationByShareId = useRef(new Map<string, number>());
  const ownerActivityByShareId = useRef(new Map<string, OwnerActivityControl>());
  const ownerDiscussionMessagesByShareId = useRef(new Map<string, RelayShareDiscussionMessage[]>());
  const expandedOwnerShareIdsRef = useRef(new Set<string>());
  const latestOwnerAppendRequest = useRef(0);
  const latestOwnerMutationRequest = useRef(0);
  const activeOwnerAppendShareId = useRef<string | null>(null);
  const activeOwnerMutationShareId = useRef<string | null>(null);
  const eligibleShareIdsRef = useRef<Set<string>>(new Set());

  const targetKey = targetKeyOf(props.target);
  const linkScope = shareScope(props.workspaceId, props.target);

  const visibleLinks = useMemo(() => {
    const readable = links.filter((row) => rowMatchesTarget(row, props.target));
    return [
      ...readable.filter((row) => row.status === "active"),
      ...readable.filter((row) => row.status === "revoked"),
      ...links.filter((row) => row.selector === null && row.status === "active"),
    ];
  }, [links, targetKey]);

  const visibleLinkGroups = useMemo(() => groupLinksByShareId(visibleLinks), [visibleLinks]);
  const activeRootGrantShareIds = useMemo(
    () => new Set(independentGrants.map((grant) => grant.shareId)),
    [independentGrants],
  );
  const eligibleShareIds = useMemo(
    () =>
      new Set(
        visibleLinkGroups
          .filter(
            (group) =>
              group.rows.some((row) => rowMatchesTarget(row, props.target)) &&
              (group.rows.some((row) => row.status === "active") ||
                activeRootGrantShareIds.has(group.shareId)),
          )
          .map((group) => group.shareId),
      ),
    [activeRootGrantShareIds, targetKey, visibleLinkGroups],
  );
  const eligibleShareIdsKey = JSON.stringify([...eligibleShareIds].sort());

  const confirmationRow = confirmation
    ? (visibleLinks.find(
        (row) =>
          row.status === "active" &&
          row.shareId === confirmation.shareId &&
          row.grantId === confirmation.grantId,
      ) ?? null)
    : null;
  const narrowerDependents =
    confirmation?.kind === "retune"
      ? (confirmationRow?.dependents.filter(
          (dependent) => shareAccessRank(dependent.access) > shareAccessRank(confirmation.access),
        ) ?? [])
      : [];
  const confirmationWidens =
    confirmation?.kind === "retune" &&
    confirmationRow !== null &&
    shareAccessRank(confirmation.access) > shareAccessRank(confirmationRow.access);
  const retuneLabels = linkRetuneLabels(
    confirmationWidens,
    confirmation?.kind === "retune" ? confirmation.access : undefined,
    confirmationRow?.access,
  );
  const confirmationActionLabel =
    confirmation?.kind === "reset"
      ? "Reset link"
      : confirmation?.kind === "end"
        ? "End link"
        : retuneLabels.action;
  const confirmationPendingLabel =
    confirmation?.kind === "reset"
      ? "Resetting…"
      : confirmation?.kind === "end"
        ? "Ending…"
        : retuneLabels.pending;
  // Ending or resetting a link retires its credential, and so does widening
  // its access. Narrowing keeps the same link.
  const LinkConfirm =
    confirmation?.kind === "reset" || confirmation?.kind === "end" || confirmationWidens
      ? DangerButton
      : PrimaryButton;
  // Making access independent grants; the other three take something away.
  const OwnerConfirm = ownerConfirmation?.kind === "promote" ? SecondaryButton : DangerButton;

  useLayoutEffect(() => {
    stopAllOwnerActivity();
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestInventoryRequest.current += 1;
    latestMutationRequest.current += 1;
    latestDiscussionRequestByShareId.current.clear();
    clearOwnerDiscussionPriority();
    latestOwnerAppendRequest.current += 1;
    latestOwnerMutationRequest.current += 1;
    activeOwnerAppendShareId.current = null;
    activeOwnerMutationShareId.current = null;
    eligibleShareIdsRef.current = new Set();
    expandedOwnerShareIdsRef.current = new Set();
    ownerDiscussionMessagesByShareId.current.clear();
    setLinkBusy(false);
    setLinkRequestBusy(null);
    setLinkAccess("view");
    setMoreOpen(false);
    setSeparateOpen(false);
    setLinksReadOnce(false);
    setOpenDetails(new Set());
    setSharesAddingLink(new Set());
    setSupportedLinkAccess(["view", "comment"]);
    setAddAccessByShareId({});
    setLinkError(null);
    setMinted(null);
    setUnsureUrls(new Set());
    focusAfterRender.current = null;
    draftOpeners.current.clear();
    setLinks([]);
    linksKey.current = null;
    setLinksLoading(false);
    setLinksError(null);
    setConfirmation(null);
    setMutationBusy(null);
    setLifecycleError(null);
    setOwnerDiscussionByShareId({});
    setIndependentGrants([]);
    setOwnerAppendBusy(null);
    setOwnerMutationBusy(null);
    setOwnerMutationError(null);
    setOwnerConfirmation(null);

    return () => {
      stopAllOwnerActivity();
      linkScopeGeneration.current += 1;
      latestMintRequest.current += 1;
      latestInventoryRequest.current += 1;
      latestMutationRequest.current += 1;
      latestDiscussionRequestByShareId.current.clear();
      clearOwnerDiscussionPriority();
      latestOwnerAppendRequest.current += 1;
      latestOwnerMutationRequest.current += 1;
      activeOwnerAppendShareId.current = null;
      activeOwnerMutationShareId.current = null;
      eligibleShareIdsRef.current = new Set();
      expandedOwnerShareIdsRef.current = new Set();
      ownerDiscussionMessagesByShareId.current.clear();
    };
  }, [linkScope]);

  useLayoutEffect(() => {
    if (!props.visible) return;
    const scopeGeneration = linkScopeGeneration.current;
    void refreshLinks(scopeGeneration);
    return () => {
      stopAllOwnerActivity();
      latestInventoryRequest.current += 1;
      for (const [shareId, requestId] of latestDiscussionRequestByShareId.current) {
        latestDiscussionRequestByShareId.current.set(shareId, requestId + 1);
      }
      clearOwnerDiscussionPriority();
      clearAllOwnerDiscussionPendingState();
      latestOwnerAppendRequest.current += 1;
      latestOwnerMutationRequest.current += 1;
      activeOwnerAppendShareId.current = null;
      activeOwnerMutationShareId.current = null;
      eligibleShareIdsRef.current = new Set();
      expandedOwnerShareIdsRef.current = new Set();
      setOwnerAppendBusy(null);
      setOwnerMutationBusy(null);
      setOwnerConfirmation(null);
    };
  }, [linkScope, props.visible]);

  useLayoutEffect(() => {
    if (!props.visible) return;
    const nextEligible = new Set(eligibleShareIds);
    const previousEligible = eligibleShareIdsRef.current;
    eligibleShareIdsRef.current = nextEligible;
    for (const shareId of previousEligible) {
      if (!nextEligible.has(shareId)) {
        invalidateDiscussionRequest(shareId);
        expandedOwnerShareIdsRef.current.delete(shareId);
        ownerDiscussionMessagesByShareId.current.delete(shareId);
        stopOwnerActivity(shareId);
      }
    }
    if (
      activeOwnerAppendShareId.current !== null &&
      !nextEligible.has(activeOwnerAppendShareId.current)
    ) {
      latestOwnerAppendRequest.current += 1;
      activeOwnerAppendShareId.current = null;
    }
    if (
      activeOwnerMutationShareId.current !== null &&
      !nextEligible.has(activeOwnerMutationShareId.current)
    ) {
      latestOwnerMutationRequest.current += 1;
      activeOwnerMutationShareId.current = null;
    }
    setOwnerAppendBusy((current) =>
      current !== null && !nextEligible.has(current) ? null : current,
    );
    setOwnerMutationBusy((current) =>
      current !== null && !nextEligible.has(current.shareId) ? null : current,
    );
    setOwnerConfirmation((current) =>
      current !== null && !nextEligible.has(current.shareId) ? null : current,
    );
    setOwnerMutationError((current) =>
      current !== null && !nextEligible.has(current.shareId) ? null : current,
    );
    setOwnerDiscussionByShareId((current) =>
      Object.fromEntries(Object.entries(current).filter(([shareId]) => nextEligible.has(shareId))),
    );
  }, [eligibleShareIdsKey, props.visible]);

  function isCurrentLinkScope(scopeGeneration: number): boolean {
    return linkScopeGeneration.current === scopeGeneration;
  }

  function isCurrentOwnerRequest(
    scopeGeneration: number,
    requestId: number,
    latestRequest: { current: number },
    shareId: string,
  ): boolean {
    return (
      isCurrentLinkScope(scopeGeneration) &&
      latestRequest.current === requestId &&
      eligibleShareIdsRef.current.has(shareId)
    );
  }

  function nextDiscussionRequest(shareId: string): number {
    const requestId = (latestDiscussionRequestByShareId.current.get(shareId) ?? 0) + 1;
    latestDiscussionRequestByShareId.current.set(shareId, requestId);
    return requestId;
  }

  function clearOwnerDiscussionPriority(shareId?: string) {
    if (shareId === undefined) {
      activeFullDiscussionRequestByShareId.current.clear();
      pendingDiscussionReconciliationByShareId.current.clear();
      return;
    }
    activeFullDiscussionRequestByShareId.current.delete(shareId);
    pendingDiscussionReconciliationByShareId.current.delete(shareId);
  }

  function clearAllOwnerDiscussionPendingState() {
    setOwnerDiscussionByShareId((current) =>
      Object.fromEntries(
        Object.entries(current).map(([shareId, state]) => [
          shareId,
          { ...state, reconciliationPending: false },
        ]),
      ),
    );
  }

  function invalidateDiscussionRequest(shareId: string) {
    clearOwnerDiscussionPriority(shareId);
    latestDiscussionRequestByShareId.current.set(
      shareId,
      (latestDiscussionRequestByShareId.current.get(shareId) ?? 0) + 1,
    );
  }

  function isCurrentDiscussionRequest(
    scopeGeneration: number,
    requestId: number,
    shareId: string,
  ): boolean {
    return (
      isCurrentLinkScope(scopeGeneration) &&
      latestDiscussionRequestByShareId.current.get(shareId) === requestId &&
      eligibleShareIdsRef.current.has(shareId)
    );
  }

  function updateOwnerDiscussion(
    shareId: string,
    update: (current: OwnerDiscussionState) => OwnerDiscussionState,
  ) {
    setOwnerDiscussionByShareId((current) => ({
      ...current,
      [shareId]: update(current[shareId] ?? emptyOwnerDiscussion()),
    }));
  }

  function stopOwnerActivity(shareId: string) {
    const generation = (latestActivityGenerationByShareId.current.get(shareId) ?? 0) + 1;
    latestActivityGenerationByShareId.current.set(shareId, generation);
    const control = ownerActivityByShareId.current.get(shareId);
    if (!control) return;
    ownerActivityByShareId.current.delete(shareId);
    if (control.retryTimer !== null) clearTimeout(control.retryTimer);
    if (control.pollId !== null) {
      void bridge()
        .cancelRelayShareDiscussionActivity({ pollId: control.pollId })
        .catch(() => undefined);
    }
  }

  function stopAllOwnerActivity() {
    for (const shareId of [...ownerActivityByShareId.current.keys()]) {
      stopOwnerActivity(shareId);
    }
  }

  function isCurrentOwnerActivity(control: OwnerActivityControl, pollId?: string): boolean {
    return (
      isCurrentLinkScope(control.scopeGeneration) &&
      control.workspaceId === props.workspaceId &&
      latestActivityGenerationByShareId.current.get(control.shareId) === control.generation &&
      ownerActivityByShareId.current.get(control.shareId) === control &&
      eligibleShareIdsRef.current.has(control.shareId) &&
      expandedOwnerShareIdsRef.current.has(control.shareId) &&
      (pollId === undefined || control.pollId === pollId)
    );
  }

  function scheduleOwnerActivityRetry(control: OwnerActivityControl) {
    if (!isCurrentOwnerActivity(control)) return;
    const delay = Math.min(
      OWNER_DISCUSSION_ACTIVITY_RETRY_MAX_MS,
      OWNER_DISCUSSION_ACTIVITY_RETRY_BASE_MS * 2 ** control.retryAttempt,
    );
    control.retryAttempt += 1;
    control.retryTimer = setTimeout(() => {
      control.retryTimer = null;
      if (isCurrentOwnerActivity(control)) void pollOwnerActivity(control);
    }, delay);
  }

  async function pollOwnerActivity(control: OwnerActivityControl) {
    if (!isCurrentOwnerActivity(control)) return;
    const pollId = crypto.randomUUID();
    control.pollId = pollId;
    try {
      const result = await bridge().pollRelayShareDiscussionActivity({
        workspaceId: control.workspaceId,
        shareId: control.shareId,
        since: control.revision,
        hold: control.nextHold,
        limit: OWNER_DISCUSSION_ACTIVITY_LIMIT,
        pollId,
      });
      if (!isCurrentOwnerActivity(control, pollId)) return;
      if (
        result.cursorRevision < control.revision ||
        (result.hasMore && result.cursorRevision <= control.revision)
      ) {
        throw new Error("Invalid discussion activity cursor");
      }
      const principalBlockedById = new Map(control.principalBlockedById);
      for (const principal of result.principals) {
        principalBlockedById.set(principal.principalId, principal.blocked);
      }

      const mergedMessages = mergeDiscussionMessages(
        ownerDiscussionMessagesByShareId.current.get(control.shareId) ?? [],
        result.messages,
      );
      if (mergedMessages === null) {
        throw new Error("Invalid discussion activity messages");
      }
      const messages = applyDiscussionPrincipalOverrides(mergedMessages, principalBlockedById);
      control.principalBlockedById = principalBlockedById;
      ownerDiscussionMessagesByShareId.current.set(control.shareId, messages);

      updateOwnerDiscussion(control.shareId, (current) => {
        if (!isCurrentOwnerActivity(control) || !current.expanded) {
          return current;
        }
        return {
          ...current,
          activityRevision: result.cursorRevision,
          linkCommentsPaused: result.linkCommentsPaused,
          messages,
        };
      });
      if (!isCurrentOwnerActivity(control, pollId)) return;
      control.revision = result.cursorRevision;
      control.nextHold = result.hasMore ? 0 : OWNER_DISCUSSION_ACTIVITY_HOLD_MS;
      control.retryAttempt = 0;
      control.pollId = null;
      void pollOwnerActivity(control);
    } catch {
      if (!isCurrentOwnerActivity(control, pollId)) return;
      control.pollId = null;
      scheduleOwnerActivityRetry(control);
    }
  }

  function startOwnerActivity(shareId: string, revision: number, scopeGeneration: number) {
    stopOwnerActivity(shareId);
    if (
      !isCurrentLinkScope(scopeGeneration) ||
      !eligibleShareIdsRef.current.has(shareId) ||
      !expandedOwnerShareIdsRef.current.has(shareId)
    ) {
      return;
    }
    const generation = latestActivityGenerationByShareId.current.get(shareId)!;
    const control: OwnerActivityControl = {
      workspaceId: props.workspaceId,
      shareId,
      scopeGeneration,
      generation,
      revision,
      principalBlockedById: new Map(),
      nextHold: OWNER_DISCUSSION_ACTIVITY_HOLD_MS,
      retryAttempt: 0,
      retryTimer: null,
      pollId: null,
    };
    ownerActivityByShareId.current.set(shareId, control);
    void pollOwnerActivity(control);
  }

  async function refreshOwnerDiscussion(
    shareId: string,
    cursor?: string,
    scopeGeneration = linkScopeGeneration.current,
  ) {
    if (!isCurrentLinkScope(scopeGeneration) || !eligibleShareIdsRef.current.has(shareId)) {
      return;
    }
    if (
      cursor !== undefined &&
      (activeFullDiscussionRequestByShareId.current.has(shareId) ||
        pendingDiscussionReconciliationByShareId.current.has(shareId))
    ) {
      return;
    }
    if (cursor === undefined) stopOwnerActivity(shareId);
    const requestId = nextDiscussionRequest(shareId);
    const fullReadToken = cursor === undefined ? Symbol() : null;
    if (fullReadToken !== null) {
      activeFullDiscussionRequestByShareId.current.set(shareId, fullReadToken);
    }
    const reconciliationPending = pendingDiscussionReconciliationByShareId.current.has(shareId);
    updateOwnerDiscussion(shareId, (current) => ({
      ...current,
      loading: cursor === undefined,
      paging: cursor !== undefined,
      loadError: reconciliationPending ? current.loadError : false,
      failedReadCursor: reconciliationPending ? current.failedReadCursor : null,
    }));

    try {
      const result = await bridge().listRelayShareDiscussion({
        workspaceId: props.workspaceId,
        shareId,
        direction: "newest-first",
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!isCurrentDiscussionRequest(scopeGeneration, requestId, shareId)) {
        return;
      }
      const currentMessages = ownerDiscussionMessagesByShareId.current.get(shareId) ?? [];
      const pageMessages =
        cursor === undefined
          ? reconcileDiscussionWindowMessages(currentMessages, result.messages)
          : mergeDiscussionMessages([], result.messages);
      if (pageMessages === null) {
        throw new Error("Invalid discussion messages");
      }
      const mergedMessages =
        cursor === undefined
          ? pageMessages
          : mergeDiscussionMessages(pageMessages, currentMessages);
      if (mergedMessages === null) {
        throw new Error("Invalid discussion messages");
      }
      const activityControl = ownerActivityByShareId.current.get(shareId);
      const messages =
        cursor !== undefined &&
        activityControl !== undefined &&
        isCurrentOwnerActivity(activityControl)
          ? applyDiscussionPrincipalOverrides(mergedMessages, activityControl.principalBlockedById)
          : mergedMessages;
      ownerDiscussionMessagesByShareId.current.set(shareId, messages);
      updateOwnerDiscussion(shareId, (current) => {
        return {
          ...current,
          loaded: true,
          loading: false,
          paging: false,
          reconciliationPending: cursor === undefined ? false : current.reconciliationPending,
          activityRevision:
            cursor === undefined ? result.activityRevision : current.activityRevision,
          linkCommentsPaused:
            cursor === undefined ? result.linkCommentsPaused : current.linkCommentsPaused,
          messages,
          nextCursor: result.nextCursor,
          loadError: false,
          failedReadCursor: null,
        };
      });
      if (cursor === undefined) {
        startOwnerActivity(shareId, result.activityRevision, scopeGeneration);
        pendingDiscussionReconciliationByShareId.current.delete(shareId);
        setOwnerMutationError((current) =>
          current?.shareId === shareId && isDiscussionMutationAction(current.actionKey)
            ? null
            : current,
        );
      }
    } catch {
      if (!isCurrentDiscussionRequest(scopeGeneration, requestId, shareId)) {
        return;
      }
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        loading: false,
        paging: false,
        loadError: true,
        failedReadCursor: cursor ?? null,
      }));
    } finally {
      if (
        fullReadToken !== null &&
        activeFullDiscussionRequestByShareId.current.get(shareId) === fullReadToken
      ) {
        activeFullDiscussionRequestByShareId.current.delete(shareId);
      }
      if (isCurrentDiscussionRequest(scopeGeneration, requestId, shareId)) {
        updateOwnerDiscussion(shareId, (current) => ({
          ...current,
          loading: false,
          paging: false,
        }));
      }
    }
  }

  function toggleOwnerDiscussion(shareId: string) {
    const state = ownerDiscussionByShareId[shareId] ?? emptyOwnerDiscussion();
    if (state.expanded) {
      expandedOwnerShareIdsRef.current.delete(shareId);
      stopOwnerActivity(shareId);
      invalidateDiscussionRequest(shareId);
      if (activeOwnerAppendShareId.current === shareId) {
        latestOwnerAppendRequest.current += 1;
        activeOwnerAppendShareId.current = null;
      }
      if (ownerAppendBusy === shareId) setOwnerAppendBusy(null);
      // A question about a person sits in People, so it stays.
      setOwnerConfirmation((current) =>
        current?.shareId === shareId && (current.kind === "delete" || current.kind === "block")
          ? null
          : current,
      );
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        expanded: false,
        loading: false,
        paging: false,
        reconciliationPending: false,
        appendIntent: null,
        appendError: false,
      }));
      return;
    }
    expandedOwnerShareIdsRef.current.add(shareId);
    updateOwnerDiscussion(shareId, (current) => ({
      ...current,
      expanded: true,
    }));
    void refreshOwnerDiscussion(shareId);
  }

  async function appendOwnerComment(shareId: string, retry: boolean) {
    if (ownerAppendBusy !== null || !eligibleShareIdsRef.current.has(shareId)) {
      return;
    }
    const state = ownerDiscussionByShareId[shareId] ?? emptyOwnerDiscussion();
    const normalizedDraft = normalizeShareDiscussionBody(state.draft);
    const intent = retry
      ? state.appendIntent
      : normalizedDraft !== null
        ? { body: normalizedDraft, idempotencyKey: crypto.randomUUID() }
        : null;
    if (intent === null) return;

    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestOwnerAppendRequest.current;
    activeOwnerAppendShareId.current = shareId;
    setOwnerAppendBusy(shareId);
    updateOwnerDiscussion(shareId, (current) => ({
      ...current,
      appendIntent: intent,
      appendError: false,
    }));

    try {
      const result = await bridge().appendRelayShareDiscussion({
        workspaceId: props.workspaceId,
        shareId,
        body: intent.body,
        idempotencyKey: intent.idempotencyKey,
      });
      if (!isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerAppendRequest, shareId)) {
        return;
      }
      const messages = mergeDiscussionMessages(
        ownerDiscussionMessagesByShareId.current.get(shareId) ?? [],
        [result.message],
      );
      if (messages === null) {
        throw new Error("Invalid discussion append message");
      }
      ownerDiscussionMessagesByShareId.current.set(shareId, messages);
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        messages,
        draft: "",
        appendIntent: null,
        appendError: false,
      }));
    } catch {
      if (!isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerAppendRequest, shareId)) {
        return;
      }
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        appendError: true,
      }));
    } finally {
      if (isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerAppendRequest, shareId)) {
        activeOwnerAppendShareId.current = null;
        setOwnerAppendBusy(null);
      }
    }
  }

  async function runOwnerMutation(
    shareId: string,
    actionKey: string,
    request: () => Promise<unknown>,
    refresh: "discussion" | "inventories",
    removal?: OwnerRemoval,
  ) {
    if (ownerMutationBusy !== null || !eligibleShareIdsRef.current.has(shareId)) {
      return;
    }
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestOwnerMutationRequest.current;
    activeOwnerMutationShareId.current = shareId;
    setOwnerMutationBusy({ shareId, actionKey });

    try {
      await request();
      if (!isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerMutationRequest, shareId)) {
        return;
      }
      setOwnerConfirmation(null);
      if (refresh === "discussion") {
        void refreshOwnerDiscussion(shareId, undefined, scopeGeneration);
      } else {
        void refreshLinks(scopeGeneration);
      }
    } catch (cause) {
      if (!isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerMutationRequest, shareId)) {
        if (removal) {
          props.shareRemovals?.failed({
            workspaceId: props.workspaceId,
            message: removal.message,
            cause,
            retry: removal.retry,
          });
        }
        return;
      }
      setOwnerConfirmation(null);
      setOwnerMutationError({
        shareId,
        actionKey,
        ...(removal ? { message: withErrorWords(removal.message, cause) } : {}),
      });
      if (refresh === "discussion") {
        pendingDiscussionReconciliationByShareId.current.add(shareId);
        updateOwnerDiscussion(shareId, (current) => ({
          ...current,
          reconciliationPending: true,
        }));
        void refreshOwnerDiscussion(shareId, undefined, scopeGeneration);
      } else {
        void refreshLinks(scopeGeneration, {
          preserveOwnerMutationError: true,
        });
      }
    } finally {
      if (isCurrentOwnerRequest(scopeGeneration, requestId, latestOwnerMutationRequest, shareId)) {
        activeOwnerMutationShareId.current = null;
        setOwnerMutationBusy(null);
      }
    }
  }

  function executeOwnerConfirmation(action: OwnerConfirmation) {
    if (action.kind === "delete") {
      void runOwnerMutation(
        action.shareId,
        `delete:${action.messageId}`,
        () =>
          bridge().deleteRelayShareDiscussionMessage({
            workspaceId: props.workspaceId,
            shareId: action.shareId,
            messageId: action.messageId,
          }),
        "discussion",
      );
      return;
    }
    if (action.kind === "block") {
      void runOwnerMutation(
        action.shareId,
        `principal:${action.principalId}`,
        () =>
          bridge().blockRelayShareDiscussionPrincipal({
            workspaceId: props.workspaceId,
            shareId: action.shareId,
            principalId: action.principalId,
          }),
        "discussion",
      );
      return;
    }
    if (action.kind === "promote") {
      void runOwnerMutation(
        action.shareId,
        `promote:${action.grantId}`,
        () =>
          bridge().promoteRelayShareGrant({
            workspaceId: props.workspaceId,
            shareId: action.shareId,
            grantId: action.grantId,
            expectedParentGrantId: action.parentGrantId,
            expectedParentGeneration: action.parentGeneration,
          }),
        "inventories",
      );
      return;
    }
    endNamedAccess(action);
  }

  // A refusal shows under the person's row while the dialog can show it. Once
  // it cannot, the shell files it, and its Try again ends the access directly:
  // the owner mutation gate only admits shares the open dialog still lists.
  function endNamedAccess(action: Extract<OwnerConfirmation, { kind: "revoke" }>) {
    const { workspaceId, shareRemovals } = props;
    const scopeGeneration = linkScopeGeneration.current;
    const subject = `${action.name}'s access to ${targetLabel(props.target)}`;
    const message = `dohc could not end ${subject}.`;
    const readAgain = () => {
      if (isCurrentLinkScope(scopeGeneration)) void refreshLinks(scopeGeneration);
    };
    const end = async () => {
      await removePersonAccess({
        workspaceId,
        person: action,
        subject,
        shareRemovals,
        restored: readAgain,
      });
      if (isCurrentLinkScope(scopeGeneration))
        setIndependentGrants((current) =>
          current.filter((grant) => grant.grantId !== action.grantId),
        );
      props.people.removed(action.grantId);
    };
    const retry = () =>
      void end().then(readAgain, (cause: unknown) =>
        shareRemovals?.failed({ workspaceId, message, cause, retry }),
      );
    void runOwnerMutation(action.shareId, `revoke:${action.grantId}`, end, "inventories", {
      message,
      retry,
    });
  }

  async function refreshLinks(
    scopeGeneration = linkScopeGeneration.current,
    options: { preserveOwnerMutationError?: boolean } = {},
  ) {
    if (!isCurrentLinkScope(scopeGeneration)) return;
    const requestId = ++latestInventoryRequest.current;
    setLinksLoading(true);
    setLinksError(null);
    try {
      const inventory: RelayShareLinkRow[] = [];
      let advertisedAccess: readonly LinkAccess[] | undefined;
      const independentInventory = new Map<string, RelayShareLinkIndependentGrant>();
      const seenLinkCursors = new Set<string>();
      let linkCursor: string | undefined;
      while (true) {
        const seenIndependentGrantCursors = new Set<string>();
        let independentGrantCursor: string | undefined;
        let nextLinkCursor: string | undefined;
        while (true) {
          if (
            !isCurrentLinkScope(scopeGeneration) ||
            latestInventoryRequest.current !== requestId
          ) {
            return;
          }
          const result = await bridge().listRelayShareLinks({
            workspaceId: props.workspaceId,
            ...(linkCursor ? { cursor: linkCursor } : {}),
            ...(independentGrantCursor ? { independentGrantCursor } : {}),
          });
          if (
            !isCurrentLinkScope(scopeGeneration) ||
            latestInventoryRequest.current !== requestId
          ) {
            return;
          }
          if (advertisedAccess && advertisedAccess.join() !== result.supportedLinkAccess.join())
            throw new Error("dohc could not load consistent link access.");
          advertisedAccess = result.supportedLinkAccess;
          if (independentGrantCursor === undefined) {
            inventory.push(...result.links);
            nextLinkCursor = result.nextCursor;
          } else if (result.nextCursor !== nextLinkCursor) {
            throw new Error("dohc could not load all links.");
          }
          for (const grant of result.independentGrants) {
            independentInventory.set(grant.grantId, grant);
          }
          if (result.nextIndependentGrantCursor === undefined) break;
          if (seenIndependentGrantCursors.has(result.nextIndependentGrantCursor)) {
            throw new Error("dohc could not load all links.");
          }
          seenIndependentGrantCursors.add(result.nextIndependentGrantCursor);
          independentGrantCursor = result.nextIndependentGrantCursor;
        }
        if (nextLinkCursor === undefined) break;
        if (seenLinkCursors.has(nextLinkCursor)) {
          throw new Error("dohc could not load all links.");
        }
        seenLinkCursors.add(nextLinkCursor);
        linkCursor = nextLinkCursor;
      }
      setSupportedLinkAccess(advertisedAccess!);
      setLinkAccess((current) => (advertisedAccess!.includes(current) ? current : "view"));
      setAddAccessByShareId((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, access]) => [
            id,
            advertisedAccess!.includes(access) ? access : "view",
          ]),
        ),
      );
      setLinks(inventory);
      setUnsureUrls(new Set());
      // Once the list holds a link's URL, that copy is the current one.
      setMinted((current) =>
        current !== null &&
        inventory.some((row) => row.grantId === current.grantId && row.url !== null)
          ? null
          : current,
      );
      const key = JSON.stringify(inventory);
      if (linksKey.current !== key) {
        linksKey.current = key;
        setLinksRevision((revision) => revision + 1);
      }
      setIndependentGrants([...independentInventory.values()]);
      if (!options.preserveOwnerMutationError) {
        setOwnerMutationError((current) =>
          current !== null && isGrantMutationAction(current.actionKey) ? null : current,
        );
      }
      setConfirmation((current) =>
        current !== null &&
        ((current.kind === "retune" && !advertisedAccess!.includes(current.access)) ||
          !inventory.some(
            (row) =>
              row.status === "active" &&
              row.shareId === current.shareId &&
              row.grantId === current.grantId,
          ))
          ? null
          : current,
      );
    } catch (cause) {
      if (!isCurrentLinkScope(scopeGeneration) || latestInventoryRequest.current !== requestId) {
        return;
      }
      setSupportedLinkAccess(["view", "comment"]);
      setLinkAccess("view");
      setAddAccessByShareId({});
      setLinksError(ipcErrorMessage(cause));
    } finally {
      if (isCurrentLinkScope(scopeGeneration) && latestInventoryRequest.current === requestId) {
        setLinksLoading(false);
        setLinksReadOnce(true);
      }
    }
  }

  async function mintLink(
    action: LinkRequestBusy,
    access: LinkAccess,
    request: () => Promise<MintedLinkResult>,
  ) {
    if (linkBusy || mutationBusy !== null || confirmation !== null) return;
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestMintRequest.current;

    setLinkBusy(true);
    setLinkRequestBusy(action);
    setLinkError(null);
    setMinted(null);
    focusAfterRender.current = null;

    try {
      const result = await request();
      if (!isCurrentLinkScope(scopeGeneration) || latestMintRequest.current !== requestId) {
        return;
      }
      setMinted({ grantId: result.grantId, url: result.url, access });
      focusAfterRender.current = { kind: "copy", grantId: result.grantId, shown: false };
      if (action.kind === "create") {
        setSeparateOpen(false);
        // A separate link joins the links past the first share, so they show.
        setMoreOpen(true);
      } else if (action.kind === "add") {
        closeAdd(action.shareId);
        if (shownShareId.current === action.shareId) setMoreOpen(true);
      }
      void refreshLinks(scopeGeneration);
    } catch (cause) {
      if (!isCurrentLinkScope(scopeGeneration) || latestMintRequest.current !== requestId) {
        return;
      }
      setLinkError({
        message: ipcErrorMessage(cause),
        shareId: action.kind === "add" ? action.shareId : null,
      });
      // The error shows beside the separate link, which may sit in that list.
      // A separate link made all the same shows there too.
      if (action.kind === "create") setMoreOpen(true);
      void refreshLinks(scopeGeneration);
    } finally {
      if (isCurrentLinkScope(scopeGeneration) && latestMintRequest.current === requestId) {
        setLinkBusy(false);
        setLinkRequestBusy(null);
      }
    }
  }

  // An Edit link makes an editor of whoever opens it, which can stop
  // automation steps. Resolves true when the link may be made now.
  async function checkAutomations(share: AutomationShare): Promise<boolean> {
    if (!automationCheck.asks(share)) return true;
    if (linkBusy || mutationBusy !== null || confirmation !== null) return false;
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestMintRequest.current;
    const current = () =>
      isCurrentLinkScope(scopeGeneration) && latestMintRequest.current === requestId;
    setLinkBusy(true);
    setLinkRequestBusy({ kind: "check", shareId: share.shareId ?? null });
    setLinkError(null);
    try {
      return (await automationCheck.mayShare(share, current)) && current();
    } finally {
      if (current()) {
        setLinkBusy(false);
        setLinkRequestBusy(null);
      }
    }
  }

  async function createLink() {
    let payload: CreateRelayShareLinkPayload;
    if (props.target.kind === "version") {
      if (linkAccess === "edit") return;
      payload = {
        workspaceId: props.workspaceId,
        versionId: props.target.versionId,
        access: linkAccess,
      };
    } else {
      payload = { workspaceId: props.workspaceId, paths: props.target.paths, access: linkAccess };
    }
    if (!(await checkAutomations({ recipientEmail: null, access: linkAccess }))) return;
    await mintLink({ kind: "create" }, payload.access, () =>
      bridge().createRelayShareLink(payload),
    );
  }

  async function addLink(shareId: string, access: LinkAccess) {
    if (!(await checkAutomations({ recipientEmail: null, access, shareId }))) return;
    await mintLink({ kind: "add", shareId }, access, () =>
      bridge().addRelayShareLink({
        workspaceId: props.workspaceId,
        shareId,
        access,
      }),
    );
  }

  function closeAdd(shareId: string) {
    setSharesAddingLink((current) => {
      if (!current.has(shareId)) return current;
      const next = new Set(current);
      next.delete(shareId);
      return next;
    });
  }

  function openAdd(shareId: string, openerGrantId: string) {
    draftOpeners.current.set(addDraft(shareId), openerGrantId);
    focusAfterRender.current = { kind: "draft", testId: `share-link-add-access-${shareId}` };
    setSharesAddingLink((current) => new Set(current).add(shareId));
  }

  function openSeparate(openerGrantId: string) {
    draftOpeners.current.set(SEPARATE_DRAFT, openerGrantId);
    focusAfterRender.current = { kind: "draft", testId: "share-link-create-access" };
    setSeparateOpen(true);
    if (createInMore) setMoreOpen(true);
  }

  function focusDraftOpener(draft: string, shareId?: string) {
    const opener = draftOpeners.current.get(draft);
    draftOpeners.current.delete(draft);
    const named = (testId: string) => `[data-testid=${JSON.stringify(testId)}]`;
    const options = '[aria-label="Link options"]';
    const places = [
      ...(opener === undefined ? [] : [named(`share-link-options-${opener}`)]),
      ...(shareId === undefined ? [] : [`${named(`share-link-group-${shareId}`)} ${options}`]),
      options,
    ];
    for (const place of places) {
      const button = document.querySelector<HTMLElement>(place);
      if (button) {
        button.focus();
        return;
      }
    }
  }

  function openConfirmation(kind: LinkConfirmation["kind"], row: RelayShareLinkRow) {
    if (linkBusy || mutationBusy !== null || row.status !== "active") return;
    setLifecycleError(null);
    setConfirmation(
      kind === "retune"
        ? {
            kind,
            shareId: row.shareId,
            grantId: row.grantId,
            access: row.access === "comment" ? "view" : "comment",
          }
        : { kind, shareId: row.shareId, grantId: row.grantId },
    );
  }

  async function mutateLink(action: LinkConfirmation, row: RelayShareLinkRow, fromNotice = false) {
    if (mutationBusy !== null || row.status !== "active") return;
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestMutationRequest.current;
    const payload = {
      workspaceId: props.workspaceId,
      shareId: row.shareId,
      grantId: row.grantId,
      expectedDependentGrantIds: dependentGrantIds(row),
    };
    // A change that may replace or end the link's URL, whether or not the
    // dialog had one to show.
    const changesCredential =
      action.kind === "reset" ||
      action.kind === "end" ||
      (action.kind === "retune" && shareAccessRank(action.access) > shareAccessRank(row.access));
    setMutationBusy({ kind: action.kind, grantId: row.grantId });
    setLifecycleError(null);

    try {
      const result =
        action.kind === "reset"
          ? await bridge().rotateRelayShareLink(payload)
          : action.kind === "end"
            ? await bridge().revokeRelayShareLink(payload)
            : await bridge().retuneRelayShareLink({
                ...payload,
                access: action.access,
              });
      // The link ended whether or not this dialog is still current, so the
      // notice and its Undo are reported before the checks below.
      if (fromNotice && result.outcome === "dependents-changed") {
        props.shareRemovals?.failed({
          workspaceId: props.workspaceId,
          message:
            "Access through this link changed. Open Share and check who has access before ending the link.",
          cause: new Error("The link's recipients changed before removal."),
        });
      }
      if (result.outcome === "ended") {
        const subject = `the link to ${targetLabel(props.target)}`;
        props.shareRemovals?.removed({
          workspaceId: props.workspaceId,
          shareId: row.shareId,
          undo: result.undo,
          message: `Ended ${subject}.`,
          restoredMessage: `Restored ${subject}.`,
          restored: () => {
            if (isCurrentLinkScope(scopeGeneration)) void refreshLinks(scopeGeneration);
          },
        });
      }
      if (!isCurrentLinkScope(scopeGeneration) || latestMutationRequest.current !== requestId) {
        return;
      }
      if (result.outcome === "dependents-changed") {
        setLinks((current) =>
          current.map((currentRow) =>
            currentRow.shareId === row.shareId && currentRow.grantId === row.grantId
              ? { ...currentRow, dependents: result.dependents }
              : currentRow,
          ),
        );
        setConfirmation(null);
        setLifecycleError(
          "Access through this link changed. Check the updated names and confirm again.",
        );
        void refreshLinks(scopeGeneration);
        return;
      }

      if (result.outcome === "rotated" || result.outcome === "widened") {
        setMinted({
          grantId: row.grantId,
          url: result.url,
          access: action.kind === "retune" ? action.access : linkAccessOf(row.access),
        });
        // The answer names the current URL, so it is no longer in doubt.
        setUnsureUrls((current) => {
          if (!current.has(row.grantId)) return current;
          const next = new Set(current);
          next.delete(row.grantId);
          return next;
        });
      } else if (result.outcome !== "narrowed") {
        setMinted((current) => (current?.grantId === row.grantId ? null : current));
      }
      // The row takes the answer now, so a list that fails to read again
      // never brings back a URL this change retired.
      setLinks((current) =>
        current.map((currentRow): RelayShareLinkRow => {
          if (currentRow.shareId !== row.shareId || currentRow.grantId !== row.grantId)
            return currentRow;
          if (result.outcome === "ended") {
            return {
              ...currentRow,
              status: "revoked",
              revokedAtMs: currentRow.revokedAtMs ?? Date.now(),
              url: null,
            };
          }
          const url =
            result.outcome === "rotated" || result.outcome === "widened"
              ? result.url
              : currentRow.url;
          return action.kind === "retune" && currentRow.selector !== null
            ? { ...currentRow, access: action.access, url }
            : { ...currentRow, url };
        }),
      );
      setConfirmation(null);
      void refreshLinks(scopeGeneration);
    } catch (cause) {
      if (action.kind === "end" && props.shareRemovals) {
        props.shareRemovals.failed({
          workspaceId: props.workspaceId,
          message: `dohc could not end the link to ${targetLabel(props.target)}.`,
          cause,
          retry: () => void mutateLink(action, row, true),
        });
      }
      if (!isCurrentLinkScope(scopeGeneration) || latestMutationRequest.current !== requestId)
        return;
      // The change may have landed: neither copy of the old URL is known to
      // work until the list reads again.
      if (changesCredential) {
        setMinted((current) => (current?.grantId === row.grantId ? null : current));
        setUnsureUrls((current) => new Set(current).add(row.grantId));
      }
      if (action.kind !== "end" || !props.shareRemovals) setLifecycleError(ipcErrorMessage(cause));
      setConfirmation(null);
      void refreshLinks(scopeGeneration);
    } finally {
      if (isCurrentLinkScope(scopeGeneration) && latestMutationRequest.current === requestId) {
        setMutationBusy(null);
      }
    }
  }

  function closeDialog() {
    stopAllOwnerActivity();
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestInventoryRequest.current += 1;
    latestMutationRequest.current += 1;
    latestDiscussionRequestByShareId.current.clear();
    clearOwnerDiscussionPriority();
    clearAllOwnerDiscussionPendingState();
    latestOwnerAppendRequest.current += 1;
    latestOwnerMutationRequest.current += 1;
    activeOwnerAppendShareId.current = null;
    activeOwnerMutationShareId.current = null;
    eligibleShareIdsRef.current = new Set();
    expandedOwnerShareIdsRef.current = new Set();
    props.onClose();
  }

  function pickLinkAccess(row: RelayShareLinkRow, access: LinkAccess) {
    if (linkBusy || mutationBusy !== null || row.status !== "active" || row.access === access)
      return;
    setLifecycleError(null);
    setConfirmation({ kind: "retune", shareId: row.shareId, grantId: row.grantId, access });
  }

  const linkControlsBusy = linkBusy || mutationBusy !== null || confirmation !== null;

  function renderLinkConfirmation(row: RelayShareLinkRow) {
    if (!confirmation) return null;
    return (
      <div
        data-testid="share-link-confirmation"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (mutationBusy === null) setConfirmation(null);
          }
        }}
        className="flex flex-col gap-3 rounded-lg bg-panel-2 p-3"
      >
        <p className="m-0 text-[13px] leading-relaxed text-ink">
          {confirmation.kind === "retune" ? (
            confirmationWidens ? (
              <>
                {confirmation.access === "edit"
                  ? "Turn on editing for this link?"
                  : "Turn on comments for this link?"}{" "}
                The current link stops working right away, and you get a new link to send. Published
                apps stop working until you review and publish them again.
                {row.dependents.length > 0 ? (
                  <>
                    {" "}
                    People who joined through it keep access and stay at their current level:{" "}
                    <DependentNames dependents={row.dependents} />.
                  </>
                ) : null}
              </>
            ) : (
              <>
                {confirmation.access === "view"
                  ? row.access === "edit"
                    ? "Turn off editing for this link? The same link keeps working, for viewing only."
                    : "Turn off comments for this link? The same link keeps working, for viewing only."
                  : row.access === "edit"
                    ? "Turn off editing for this link? The same link keeps working. Anyone with the link can view and comment."
                    : "Use Comment access for this link? The same link keeps working. Anyone with the link can view and comment."}
                {narrowerDependents.length > 0 ? (
                  <>
                    {" "}
                    These people drop to {confirmation.access === "comment"
                      ? "Comment"
                      : "View"}{" "}
                    too: <DependentNames dependents={narrowerDependents} />.
                  </>
                ) : null}
              </>
            )
          ) : confirmation.kind === "reset" ? (
            <>
              Reset this link? The current link stops working right away, and you get a new link to
              send. Published apps stop working until you review and publish them again.
              {row.dependents.length > 0 ? (
                <>
                  {" "}
                  People who joined through it keep access:{" "}
                  <DependentNames dependents={row.dependents} />. To remove them, end the link
                  instead.
                </>
              ) : null}
            </>
          ) : row.dependents.length === 0 ? (
            <>
              End this link? It stops working right away. Copies people already made stay with them.
            </>
          ) : (
            <>
              End this link? It stops working right away, and these people lose access through it:{" "}
              <DependentNames dependents={row.dependents} />. Copies they already made stay with
              them.
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <SecondaryButton
            autoFocus
            disabled={mutationBusy !== null}
            onClick={() => setConfirmation(null)}
          >
            Cancel
          </SecondaryButton>
          <LinkConfirm
            disabled={mutationBusy !== null}
            onClick={() => void mutateLink(confirmation, row)}
          >
            {mutationBusy?.grantId === row.grantId
              ? confirmationPendingLabel
              : confirmationActionLabel}
          </LinkConfirm>
        </div>
      </div>
    );
  }

  function renderDraftLink(draft: {
    name: string;
    detail?: string;
    testId: string;
    accessTestId: string;
    submitTestId: string;
    supported: readonly LinkAccess[];
    access: LinkAccess;
    onAccess: (access: LinkAccess) => void;
    submit: string;
    onSubmit: () => void;
    onCancel?: () => void;
    note: { warning: string | null; failed: boolean } | null;
    error: string | null;
  }) {
    return (
      <section
        key={draft.testId}
        aria-label={draft.name}
        data-testid={draft.testId}
        className="flex flex-col gap-1"
      >
        <ShareLinkRow>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] text-muted">{draft.name}</span>
            {draft.detail ? (
              <span className="truncate text-[12px] leading-4 text-muted">{draft.detail}</span>
            ) : null}
          </span>
          <ShareAccessMenu
            label="Link access"
            access={draft.access}
            options={draft.supported.map((value) => ({
              value,
              description: SHARE_ACCESS_DESCRIPTIONS[value],
            }))}
            note={newLinkReach(props.target)}
            disabled={linkControlsBusy}
            testId={draft.accessTestId}
            width={288}
            align="end"
            onPick={draft.onAccess}
          />
          {/* The dialog's one filled button is Invite. */}
          <SecondaryButton
            type="button"
            data-testid={draft.submitTestId}
            className="shrink-0"
            disabled={linkControlsBusy}
            onClick={draft.onSubmit}
          >
            {draft.submit}
          </SecondaryButton>
          {draft.onCancel ? (
            <IconButton
              aria-label={`Cancel ${draft.name.toLowerCase()}`}
              title="Cancel"
              disabled={linkBusy}
              onClick={draft.onCancel}
            >
              <X size={13} aria-hidden />
            </IconButton>
          ) : null}
        </ShareLinkRow>
        {draft.note?.warning || draft.note?.failed || draft.error ? (
          <div className={`flex flex-col gap-1 ${SHARE_ROW_INSET}`}>
            <AutomationShareNote note={draft.note} />
            {draft.error ? (
              <p
                data-testid="share-link-error"
                role="alert"
                className="m-0 text-[12px] text-danger"
              >
                {draft.error}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
    );
  }

  function renderLinkUrl(url: string) {
    return (
      <div className="flex h-8 min-w-0 items-center rounded-lg border border-line bg-bg px-3 text-[12px] text-muted">
        <code
          data-testid="share-link-url"
          title={url}
          className="min-w-0 select-text truncate font-sans"
        >
          {url}
        </code>
      </div>
    );
  }

  function renderLinkDetails(grantId: string, details: ReactNode) {
    const detailsId = `share-link-details-list-${grantId}`;
    const detailsOpen = openDetails.has(grantId);
    return (
      <div className={`flex flex-col gap-2 ${SHARE_ROW_INSET}`}>
        <GhostButton
          className="-ml-2 self-start"
          data-testid={`share-link-details-${grantId}`}
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={() =>
            setOpenDetails((current) => {
              const next = new Set(current);
              if (!next.delete(grantId)) next.add(grantId);
              return next;
            })
          }
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={`transition-transform duration-150 ${detailsOpen ? "rotate-90" : ""}`}
          />
          Link details
        </GhostButton>
        {detailsOpen ? (
          <div id={detailsId} className="flex flex-col gap-2 pb-2">
            {details}
          </div>
        ) : null}
      </div>
    );
  }

  function renderLinkRow(group: LinkGroup, row: RelayShareLinkRow, carriesShareActions = false) {
    const damaged = row.selector === null;
    const active = row.status === "active";
    const access = linkAccessOf(row.access);
    const retuneTo =
      !damaged && access !== null
        ? row.selector?.versionId === null
          ? availableLinkAccess
          : availableLinkAccess.filter((option) => option !== "edit")
        : [];
    const canReset =
      !damaged &&
      (row.access !== "edit" ||
        (availableLinkAccess.includes("edit") && row.selector?.versionId === null));
    // A link made or reset in this dialog is the one to send now; every
    // other active link shows the copy the relay keeps for its owner.
    const unsure = unsureUrls.has(row.grantId);
    const url =
      !active || damaged || unsure ? null : minted?.grantId === row.grantId ? minted.url : row.url;
    const used =
      row.lastUsedAtMs === null
        ? "Not used yet"
        : `Used ${shortTimestamp.format(row.lastUsedAtMs)}`;
    const issued =
      row.urlIssuedAtMs !== null && row.urlIssuedAtMs > row.createdAtMs
        ? ` · Link reset ${shortDate.format(row.urlIssuedAtMs)}`
        : "";
    const confirming = confirmation !== null && confirmationRow?.grantId === row.grantId;
    const busy = linkBusy || mutationBusy !== null;
    const lifecycle: MenuEntry[] = !active
      ? []
      : [
          ...(canReset
            ? [
                {
                  id: "reset",
                  label: "Reset link",
                  ...waits(busy),
                  onSelect: () => openConfirmation("reset", row),
                },
              ]
            : []),
          {
            id: "end",
            label: "End link",
            danger: true,
            ...waits(busy),
            onSelect: () => openConfirmation("end", row),
          },
        ];
    const ofShare: MenuEntry[] = [
      ...(carriesShareActions
        ? [
            {
              id: "comments",
              label: ownerDiscussionByShareId[group.shareId]?.expanded
                ? "Hide comments"
                : "Comments",
              onSelect: () => toggleOwnerDiscussion(group.shareId),
            },
            {
              id: "add",
              label: "Add another link",
              ...waits(linkControlsBusy),
              onSelect: () => openAdd(group.shareId, row.grantId),
            },
          ]
        : []),
      ...(isWorking(row)
        ? [
            {
              id: "separate",
              label: "New separate link",
              ...waits(linkControlsBusy),
              onSelect: () => openSeparate(row.grantId),
            },
          ]
        : []),
    ];
    const items: MenuEntry[] =
      ofShare.length > 0 && lifecycle.length > 0
        ? [...ofShare, MENU_SEPARATOR, ...lifecycle]
        : [...ofShare, ...lifecycle];
    const options =
      items.length > 0 ? (
        <ShareOptionsMenu
          label="Link options"
          testId={`share-link-options-${row.grantId}`}
          items={items}
        />
      ) : null;
    return (
      <article
        key={row.grantId}
        data-testid={`share-link-row-${row.grantId}`}
        data-status={row.status}
        className="flex flex-col gap-1"
      >
        <ShareLinkRow linkUrlFor={row.grantId}>
          {damaged ? (
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-muted">
              Unreadable link. dohc cannot read what this link shares.
            </p>
          ) : (
            <div className="-ml-2 flex shrink-0">
              {active && access !== null && retuneTo.length > 1 ? (
                // Picking a level opens the row's confirmation.
                <ShareAccessMenu
                  label="Access for this link"
                  access={access}
                  options={retuneTo.map((value) => ({ value }))}
                  disabled={busy}
                  testId={`share-link-access-${row.grantId}`}
                  onPick={(next) => pickLinkAccess(row, next)}
                />
              ) : (
                <ShareAccessLevel>
                  {access === null ? row.access : SHARE_ACCESS_WORDS[access]}
                </ShareAccessLevel>
              )}
            </div>
          )}
          {!active ? (
            <>
              <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
                Ended {shortDate.format(row.revokedAtMs ?? row.createdAtMs)}
              </span>
              {damaged ? null : options}
            </>
          ) : damaged ? (
            options
          ) : (
            // Keyed by the link, so a reset link is a new control.
            <LinkRowActions
              key={url ?? ""}
              grantId={row.grantId}
              url={url}
              everyday={ofShare}
              lifecycle={lifecycle}
            />
          )}
        </ShareLinkRow>

        {!active || damaged || url !== null ? null : unsure ? (
          <p
            data-testid="share-link-unsure"
            className={`m-0 text-[12px] leading-4 text-muted ${SHARE_ROW_INSET}`}
          >
            dohc could not load the current link.
          </p>
        ) : (
          <p
            data-testid="share-link-no-copy"
            className={`m-0 text-[12px] leading-4 text-muted ${SHARE_ROW_INSET}`}
          >
            {canReset
              ? "dohc has no copy of this link. Reset it to get a link you can copy."
              : "dohc has no copy of this link."}
          </p>
        )}

        {confirming ? <div className={SHARE_ROW_INSET}>{renderLinkConfirmation(row)}</div> : null}

        {active && !damaged
          ? renderLinkDetails(
              row.grantId,
              <>
                {url !== null ? renderLinkUrl(url) : null}
                <p className="m-0 text-[12px] leading-4 text-subtle">
                  {used} · Created {shortDate.format(row.createdAtMs)}
                  {issued}
                </p>
                <LinkAgentsList
                  key={`${props.workspaceId}:${group.shareId}:${row.grantId}`}
                  workspaceId={props.workspaceId}
                  shareId={group.shareId}
                  grantId={row.grantId}
                  revision={linksRevision}
                  disconnects={agentDisconnects}
                />
              </>,
            )
          : null}
      </article>
    );
  }

  function renderOwnerConfirmation(pending: OwnerConfirmation) {
    return (
      <div
        data-testid="owner-comments-confirmation"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (ownerMutationBusy === null) setOwnerConfirmation(null);
          }
        }}
        className="flex flex-col gap-3 rounded-lg bg-panel-2 p-3"
      >
        <p className="m-0 text-[13px] leading-relaxed text-ink">
          {pending.kind === "delete"
            ? "Delete this comment? This cannot be undone. Readers see that a comment was deleted."
            : pending.kind === "block"
              ? `Block ${pending.name}? They cannot comment through this link from this browser until you unblock them. They can still comment from another browser or another link. To stop everyone with this link, reset it.`
              : pending.kind === "promote"
                ? `Make ${pending.name}'s access independent of this link? This is permanent. Resetting or ending the link no longer affects their access. You can end their access here at any time.`
                : `Remove ${pending.name}'s access? They lose access right away. Copies they already made stay with them.`}
        </p>
        <div className="flex justify-end gap-2">
          <SecondaryButton
            autoFocus
            disabled={ownerMutationBusy !== null}
            onClick={() => setOwnerConfirmation(null)}
          >
            Cancel
          </SecondaryButton>
          <OwnerConfirm
            disabled={ownerMutationBusy !== null}
            aria-busy={ownerMutationBusy !== null}
            onClick={() => executeOwnerConfirmation(pending)}
          >
            {pending.kind === "delete"
              ? "Delete comment"
              : pending.kind === "block"
                ? "Block"
                : pending.kind === "promote"
                  ? "Make independent"
                  : "Remove access"}
          </OwnerConfirm>
        </div>
      </div>
    );
  }

  function peopleOf(group: LinkGroup) {
    const displayedDependentIds = new Set(
      group.rows.flatMap((row) =>
        row.status === "active" ? row.dependents.map((dependent) => dependent.grantId) : [],
      ),
    );
    return {
      independent: independentGrants.filter(
        (grant) =>
          grant.shareId === group.shareId &&
          grant.recipientUserId !== null &&
          !displayedDependentIds.has(grant.grantId),
      ),
      linked: group.rows.flatMap((row) =>
        row.status === "active"
          ? row.dependents
              .filter((dependent) => dependent.recipientUserId !== null)
              .map((dependent) => ({ row, dependent }))
          : [],
      ),
    };
  }

  function renderPeople(group: LinkGroup) {
    const drawn = peopleOf(group);
    const independentPeople = props.people.answered(drawn.independent.map(personOfGrant));
    const linkedPeople = drawn.linked;
    if (linkedPeople.length === 0 && independentPeople.length === 0) return null;
    const scopeGeneration = linkScopeGeneration.current;
    const refused = (actionKey: string) =>
      ownerMutationError?.shareId === group.shareId &&
      ownerMutationError.actionKey === actionKey ? (
        <p role="alert" className="m-0 text-[12px] text-danger">
          dohc could not complete that change.
        </p>
      ) : null;
    return (
      <div
        key={group.shareId}
        data-testid={`share-people-${group.shareId}`}
        className="flex flex-col gap-1"
      >
        {linkedPeople.map(({ row, dependent }) => {
          const name = dependentName(dependent);
          const error = refused(`promote:${dependent.grantId}`);
          return (
            <div
              key={`${row.grantId}:${dependent.grantId}`}
              data-testid={`share-dependent-${dependent.grantId}`}
              className="flex flex-col gap-1"
            >
              <SharePersonRow name={name} detail="Joined through a link">
                <ShareAccessLevel>{accessWords(dependent.access)}</ShareAccessLevel>
                <ShareOptionsMenu
                  label={`Options for ${name}`}
                  testId={`share-person-options-${dependent.grantId}`}
                  width={176}
                  items={[
                    {
                      id: "promote",
                      label: "Make independent",
                      ...waits(ownerMutationBusy !== null),
                      onSelect: () =>
                        setOwnerConfirmation({
                          kind: "promote",
                          shareId: group.shareId,
                          grantId: dependent.grantId,
                          parentGrantId: row.grantId,
                          parentGeneration: row.generation,
                          name,
                        }),
                    },
                  ]}
                />
              </SharePersonRow>
              {error ? <div className={SHARE_ROW_INSET}>{error}</div> : null}
            </div>
          );
        })}
        {independentPeople.map((person) => {
          const removal: Extract<OwnerConfirmation, { kind: "revoke" }> = {
            kind: "revoke",
            shareId: group.shareId,
            grantId: person.grantId,
            name: person.name,
          };
          const removeError =
            ownerMutationError?.shareId === group.shareId &&
            ownerMutationError.actionKey === `revoke:${person.grantId}`
              ? ownerMutationError.message
              : undefined;
          return (
            <PersonAccessRow
              key={person.grantId}
              testId={`share-independent-${person.grantId}`}
              workspaceId={props.workspaceId}
              target={props.target}
              person={person}
              busy={ownerMutationBusy !== null}
              actions={[
                {
                  id: "remove",
                  label: "Remove access",
                  danger: true,
                  testId: `share-remove-${person.grantId}`,
                  onSelect: () => setOwnerConfirmation(removal),
                },
              ]}
              onAccessChanged={(changed) => {
                if (!isCurrentLinkScope(scopeGeneration)) return;
                props.people.changed({ ...person, ...changed });
                void refreshLinks(scopeGeneration);
              }}
            >
              {removeError ? (
                <PersonRemovalError
                  grantId={person.grantId}
                  busy={ownerMutationBusy !== null}
                  onRetry={() => endNamedAccess(removal)}
                >
                  {removeError}
                </PersonRemovalError>
              ) : null}
            </PersonAccessRow>
          );
        })}
        {ownerConfirmation?.shareId === group.shareId &&
        (ownerConfirmation.kind === "promote" || ownerConfirmation.kind === "revoke")
          ? renderOwnerConfirmation(ownerConfirmation)
          : null}
      </div>
    );
  }

  function renderOwnerDiscussion(group: LinkGroup) {
    const ownerDiscussion = ownerDiscussionByShareId[group.shareId] ?? emptyOwnerDiscussion();
    const ownerDraftInvalid =
      ownerDiscussion.draft.length > 0 &&
      normalizeShareDiscussionBody(ownerDiscussion.draft) === null;
    const showOwnerAppendRetry = ownerDiscussion.appendError && !ownerDraftInvalid;
    const ownerDraftErrorId = `share-comment-body-error-${group.shareId}`;
    return (
      <div
        data-testid={`share-comments-${group.shareId}`}
        className={`flex flex-col gap-3 pb-2 ${SHARE_ROW_INSET}`}
      >
        <div className="flex items-center gap-2">
          <p className="m-0 min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
            {ownerDiscussion.linkCommentsPaused
              ? "Link comments are paused. People with links can still read everything."
              : "Comments from everyone with a link to this share."}
          </p>
          <SecondaryButton
            size="compact"
            disabled={ownerMutationBusy !== null}
            aria-busy={
              ownerMutationBusy?.shareId === group.shareId &&
              ownerMutationBusy.actionKey === "pause"
            }
            onClick={() =>
              void runOwnerMutation(
                group.shareId,
                "pause",
                () =>
                  ownerDiscussion.linkCommentsPaused
                    ? bridge().resumeRelayShareDiscussion({
                        workspaceId: props.workspaceId,
                        shareId: group.shareId,
                      })
                    : bridge().pauseRelayShareDiscussion({
                        workspaceId: props.workspaceId,
                        shareId: group.shareId,
                      }),
                "discussion",
              )
            }
          >
            {ownerDiscussion.linkCommentsPaused ? "Resume link comments" : "Pause link comments"}
          </SecondaryButton>
        </div>
        {ownerMutationError?.shareId === group.shareId &&
        ownerMutationError.actionKey === "pause" ? (
          <p role="alert" className="m-0 text-[12px] text-danger">
            dohc could not complete that change.
          </p>
        ) : null}

        {ownerDiscussion.loading ? (
          ownerDiscussion.loaded ? (
            <p role="status" className="m-0 text-[12px] text-muted">
              Loading comments…
            </p>
          ) : (
            <SkeletonRows rows={2} label="Loading comments…" />
          )
        ) : null}

        {ownerDiscussion.loadError ? (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="m-0 text-[12px] text-danger">
              dohc could not load comments.
            </p>
            <SecondaryButton
              size="compact"
              disabled={ownerDiscussion.loading}
              onClick={() =>
                void refreshOwnerDiscussion(
                  group.shareId,
                  ownerDiscussion.failedReadCursor ?? undefined,
                )
              }
            >
              Try again
            </SecondaryButton>
          </div>
        ) : null}

        {ownerDiscussion.loaded &&
        !ownerDiscussion.loading &&
        ownerDiscussion.messages.length === 0 ? (
          <p className="m-0 text-[12px] text-muted">No comments yet.</p>
        ) : null}

        {ownerDiscussion.messages.length > 0 ? (
          <ol className="m-0 flex max-h-64 list-none flex-col overflow-y-auto p-0">
            {ownerDiscussion.messages.map((message) => {
              const linkAuthored = "moderation" in message;
              const deleteActionKey = `delete:${message.messageId}`;
              const principalActionKey = linkAuthored
                ? `principal:${message.moderation.linkPrincipalId}`
                : null;
              const items = [
                ...(!message.deleted
                  ? [
                      {
                        label: "Delete comment",
                        disabled: ownerMutationBusy !== null,
                        onSelect: () =>
                          setOwnerConfirmation({
                            kind: "delete",
                            shareId: group.shareId,
                            messageId: message.messageId,
                          }),
                      },
                    ]
                  : []),
                ...(linkAuthored
                  ? [
                      message.moderation.blocked
                        ? {
                            label: "Unblock",
                            disabled: ownerMutationBusy !== null,
                            onSelect: () =>
                              void runOwnerMutation(
                                group.shareId,
                                principalActionKey!,
                                () =>
                                  bridge().unblockRelayShareDiscussionPrincipal({
                                    workspaceId: props.workspaceId,
                                    shareId: group.shareId,
                                    principalId: message.moderation.linkPrincipalId,
                                  }),
                                "discussion",
                              ),
                          }
                        : {
                            label: "Block",
                            disabled: ownerMutationBusy !== null,
                            onSelect: () =>
                              setOwnerConfirmation({
                                kind: "block",
                                shareId: group.shareId,
                                principalId: message.moderation.linkPrincipalId,
                                name: message.author.displayName,
                              }),
                          },
                    ]
                  : []),
              ];
              return (
                <li
                  key={message.messageId}
                  data-testid={`share-comment-${message.messageId}`}
                  data-comment-message-id={message.messageId}
                  className="flex flex-col gap-1 border-t border-line py-2 first:border-t-0 first:pt-0"
                >
                  <div className="flex min-h-6 items-center gap-2 text-[12px]">
                    <span className="min-w-0 truncate font-medium text-ink">
                      {message.author.displayName}
                    </span>
                    {message.author.kind === "link" ? (
                      <span className="shrink-0 text-subtle">Unverified</span>
                    ) : null}
                    {linkAuthored && message.moderation.blocked ? (
                      <span className="shrink-0 text-subtle">Blocked</span>
                    ) : null}
                    <span className="flex-1" />
                    {items.map((item) => (
                      <SecondaryButton
                        key={item.label}
                        size="row"
                        disabled={item.disabled}
                        onClick={item.onSelect}
                      >
                        {item.label}
                      </SecondaryButton>
                    ))}
                  </div>
                  <p
                    className={`m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed ${message.deleted ? "text-subtle" : "text-ink"}`}
                  >
                    {message.deleted ? "Comment deleted by the owner" : message.body}
                  </p>
                  {ownerMutationError?.shareId === group.shareId &&
                  (ownerMutationError.actionKey === deleteActionKey ||
                    ownerMutationError.actionKey === principalActionKey) ? (
                    <p role="alert" className="m-0 text-[12px] text-danger">
                      dohc could not complete that change.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}

        {ownerDiscussion.nextCursor !== null ? (
          <SecondaryButton
            size="compact"
            className="self-start"
            disabled={
              ownerDiscussion.loading ||
              ownerDiscussion.paging ||
              ownerDiscussion.reconciliationPending
            }
            onClick={() =>
              void refreshOwnerDiscussion(group.shareId, ownerDiscussion.nextCursor ?? undefined)
            }
          >
            Show more comments
          </SecondaryButton>
        ) : null}

        <div className="flex flex-col gap-2">
          <textarea
            aria-label="Add a comment"
            placeholder="Add a comment"
            value={ownerDiscussion.draft}
            disabled={ownerAppendBusy !== null}
            aria-invalid={ownerDraftInvalid || undefined}
            aria-describedby={ownerDraftInvalid ? ownerDraftErrorId : undefined}
            rows={2}
            onChange={(event) => {
              const draft = event.currentTarget.value.replaceAll("\u0000", "");
              updateOwnerDiscussion(group.shareId, (current) => ({
                ...current,
                draft,
                appendIntent: null,
                appendError: false,
              }));
            }}
            className="w-full resize-y rounded-lg border border-line bg-bg px-3 py-2 text-[13px] leading-relaxed text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
          />
          {ownerDraftInvalid ? (
            <p id={ownerDraftErrorId} role="alert" className="m-0 text-[12px] text-danger">
              This comment is too long. Shorten it before posting.
            </p>
          ) : showOwnerAppendRetry ? (
            <p role="alert" className="m-0 text-[12px] text-danger">
              dohc could not post the comment.
            </p>
          ) : null}
          <div className="flex justify-end">
            <SecondaryButton
              size="compact"
              disabled={
                ownerAppendBusy !== null ||
                ownerDraftInvalid ||
                (!showOwnerAppendRetry && ownerDiscussion.draft.length === 0)
              }
              aria-busy={ownerAppendBusy === group.shareId}
              onClick={() => void appendOwnerComment(group.shareId, showOwnerAppendRetry)}
            >
              {showOwnerAppendRetry ? "Try again" : "Post"}
            </SecondaryButton>
          </div>
        </div>

        {ownerConfirmation?.shareId === group.shareId &&
        (ownerConfirmation.kind === "delete" || ownerConfirmation.kind === "block")
          ? renderOwnerConfirmation(ownerConfirmation)
          : null}
      </div>
    );
  }

  function renderLinkGroup(group: LinkGroup, rows: readonly RelayShareLinkRow[] = group.rows) {
    const { shareId } = group;
    const canAdd = eligibleShareIds.has(shareId);
    const addAccess = addAccessByShareId[shareId] ?? "view";
    const addNote = automationCheck.noteFor({ recipientEmail: null, access: addAccess, shareId });
    const adding =
      linkRequestBusy !== null &&
      linkRequestBusy.kind !== "create" &&
      linkRequestBusy.shareId === shareId
        ? linkRequestBusy.kind
        : null;
    const addSupported = group.rows.some((row) => row.selector?.versionId !== null)
      ? availableLinkAccess.filter((access) => access !== "edit")
      : availableLinkAccess;
    return (
      <div
        key={shareId}
        data-testid={`share-link-group-${shareId}`}
        className="flex flex-col gap-1"
      >
        {rows.map((row) =>
          renderLinkRow(
            group,
            row,
            canAdd && (row.status === "active" || (row === rows[0] && !rows.some(isActive))),
          ),
        )}

        {canAdd && (sharesAddingLink.has(shareId) || adding !== null)
          ? renderDraftLink({
              name: "Another link",
              detail: "Same comments",
              testId: addDraft(shareId),
              accessTestId: `share-link-add-access-${shareId}`,
              submitTestId: `share-link-add-submit-${shareId}`,
              supported: addSupported,
              access: addAccess,
              onAccess: (access) =>
                setAddAccessByShareId((current) => ({ ...current, [shareId]: access })),
              submit:
                adding === "check"
                  ? "Checking automations…"
                  : adding === "add"
                    ? "Adding link…"
                    : addNote?.warning
                      ? "Add link anyway"
                      : "Add link",
              onSubmit: () => void addLink(shareId, addAccess),
              onCancel: () => {
                focusDraftOpener(addDraft(shareId), shareId);
                closeAdd(shareId);
                setAddAccessByShareId((current) => ({ ...current, [shareId]: "view" }));
                setLinkError((current) => (current?.shareId === shareId ? null : current));
              },
              note: addNote,
              error: linkError?.shareId === shareId ? linkError.message : null,
            })
          : null}

        {canAdd && ownerDiscussionByShareId[shareId]?.expanded
          ? renderOwnerDiscussion(group)
          : null}
      </div>
    );
  }

  // A new link shows at once, before the list that holds it reads again.
  const mintedElsewhere =
    minted !== null &&
    !visibleLinks.some((row) => row.grantId === minted.grantId && row.status === "active");

  // One link shows. The first to show is the oldest working link, so a new
  // link never moves it, and it keeps its place while it works. When it stops
  // working, its share's oldest working link takes its place. Every other
  // link, of that share or of another share of this selection with its own
  // comments, waits under one line.
  const isWorking = (row: RelayShareLinkRow) =>
    row.status === "active" && rowMatchesTarget(row, props.target);
  const firstWorkingLink = (group: LinkGroup) =>
    group.rows
      .filter(isWorking)
      .sort(
        (left, right) =>
          left.createdAtMs - right.createdAtMs || left.grantId.localeCompare(right.grantId),
      )[0];
  const primaryGroup =
    visibleLinkGroups.find(
      (group) => group.shareId === shownShareId.current && group.rows.some(isWorking),
    ) ??
    visibleLinkGroups.reduce<LinkGroup | null>((oldest, group) => {
      const link = firstWorkingLink(group);
      if (!link) return oldest;
      const held = oldest ? firstWorkingLink(oldest)! : null;
      return held === null ||
        link.createdAtMs < held.createdAtMs ||
        (link.createdAtMs === held.createdAtMs && link.grantId < held.grantId)
        ? group
        : oldest;
    }, null);
  shownShareId.current = primaryGroup?.shareId ?? null;
  const primaryRow = primaryGroup
    ? (primaryGroup.rows.find((row) => row.grantId === shownGrantId.current && isWorking(row)) ??
      firstWorkingLink(primaryGroup)!)
    : null;
  shownGrantId.current = primaryRow?.grantId ?? null;
  const primaryRows = primaryRow ? [primaryRow] : [];
  const primaryRest = primaryGroup?.rows.filter((row) => row !== primaryRow) ?? [];
  const moreGroups = visibleLinkGroups.filter((group) => group !== primaryGroup);
  const moreLinkCount =
    primaryRest.length + moreGroups.reduce((count, group) => count + group.rows.length, 0);
  // A separate link is made beside the other separate links, once there are any.
  const createInMore = primaryGroup !== null && moreLinkCount > 0;

  const createError = linkError !== null && linkError.shareId === null ? linkError.message : null;
  const creating =
    linkRequestBusy?.kind === "create" ||
    (linkRequestBusy?.kind === "check" && linkRequestBusy.shareId === null);
  // While a link works, another link is added to its share from its menu. A
  // separate share is the rarer choice, asked for from the same menu.
  const separateHidden =
    primaryGroup !== null &&
    !separateOpen &&
    !newLinkNote?.warning &&
    !creating &&
    createError === null;
  const createHidden =
    separateHidden ||
    (primaryGroup === null &&
      !creating &&
      createError === null &&
      !newLinkNote?.warning &&
      (!linksReadOnce || (mintedElsewhere && linksLoading)));

  const createSection = createHidden
    ? null
    : renderDraftLink({
        name:
          primaryGroup !== null
            ? "Separate link"
            : mintedElsewhere || linksError
              ? "New link"
              : "No link",
        ...(primaryGroup !== null ? { detail: "Its own comments" } : {}),
        testId: SEPARATE_DRAFT,
        accessTestId: "share-link-create-access",
        submitTestId: "share-link-create",
        supported: availableLinkAccess,
        access: linkAccess,
        onAccess: setLinkAccess,
        submit:
          linkRequestBusy?.kind === "check" && linkRequestBusy.shareId === null
            ? "Checking automations…"
            : linkRequestBusy?.kind === "create"
              ? "Creating link…"
              : newLinkNote?.warning
                ? "Create link anyway"
                : "Create link",
        onSubmit: () => void createLink(),
        ...(primaryGroup !== null
          ? {
              onCancel: () => {
                focusDraftOpener(SEPARATE_DRAFT);
                setSeparateOpen(false);
                setLinkAccess("view");
                setLinkError((current) => (current?.shareId === null ? null : current));
              },
            }
          : {}),
        note: newLinkNote,
        error: createError,
      });

  // What sits under the closed list stops with it: its comments stop reading,
  // and a question open on one of its links no longer holds the links that
  // show. A share can also move there when its last working link ends.
  const hiddenComments = moreOpen
    ? []
    : moreGroups
        .filter((group) => ownerDiscussionByShareId[group.shareId]?.expanded)
        .map((group) => group.shareId);
  const hiddenQuestion =
    !moreOpen &&
    confirmation !== null &&
    !primaryRows.some((row) => row.grantId === confirmation.grantId);
  useLayoutEffect(() => {
    for (const shareId of hiddenComments) toggleOwnerDiscussion(shareId);
    if (hiddenQuestion) setConfirmation(null);
  });

  function toggleMore() {
    if (moreOpen && createInMore) setSeparateOpen(false);
    setMoreOpen(!moreOpen);
  }

  const groupsWithPeople = props.visible
    ? visibleLinkGroups.filter((group) => eligibleShareIds.has(group.shareId))
    : [];
  const peopleGroups = groupsWithPeople
    .map((group) => renderPeople(group))
    .filter((group) => group !== null);
  const peopleGrantIds = new Set(
    groupsWithPeople.flatMap((group) => {
      const drawn = peopleOf(group);
      return [
        ...drawn.independent.map((grant) => grant.grantId),
        ...drawn.linked.map(({ dependent }) => dependent.grantId),
      ];
    }),
  );

  return {
    content: props.visible ? (
      <section className="flex flex-col gap-1" aria-labelledby="share-links-heading">
        <SectionLabel as="h3" id="share-links-heading" className="m-0">
          Anyone with the link
        </SectionLabel>

        {mintedElsewhere ? (
          <div data-testid="share-link-new" className="flex flex-col gap-1">
            <ShareLinkRow linkUrlFor={minted.grantId}>
              {minted.access ? (
                <div className="-ml-2 flex shrink-0">
                  <ShareAccessLevel>{SHARE_ACCESS_WORDS[minted.access]}</ShareAccessLevel>
                </div>
              ) : null}
              <LinkRowActions
                key={minted.url}
                grantId={minted.grantId}
                url={minted.url}
                everyday={[]}
                lifecycle={[]}
              />
            </ShareLinkRow>
            {renderLinkDetails(minted.grantId, renderLinkUrl(minted.url))}
          </div>
        ) : null}

        {/* Lines stand in only for links not yet shown; a refresh keeps the
            links on screen and says so. */}
        {linksLoading ? (
          visibleLinkGroups.length ? (
            <p role="status" className="sr-only">
              Loading links…
            </p>
          ) : (
            <SkeletonRows rows={2} label="Loading links…" className="py-2" />
          )
        ) : null}

        {linksError ? (
          <div className="flex items-center justify-between gap-3">
            <p role="alert" className="m-0 min-w-0 text-[12px] text-danger">
              {linksError}
            </p>
            <SecondaryButton size="compact" onClick={() => void refreshLinks()}>
              Try again
            </SecondaryButton>
          </div>
        ) : null}

        {lifecycleError ? (
          <p role="alert" className="m-0 text-[12px] leading-relaxed text-danger">
            {lifecycleError}
          </p>
        ) : null}

        {primaryGroup ? renderLinkGroup(primaryGroup, primaryRows) : null}

        {createInMore ? null : createSection}

        {moreLinkCount > 0 ? (
          <>
            <GhostButton
              className="-ml-2 self-start"
              data-testid="share-links-more"
              aria-expanded={moreOpen}
              aria-controls="share-links-more-list"
              onClick={toggleMore}
            >
              <ChevronRight
                size={13}
                aria-hidden
                className={`transition-transform duration-150 ${moreOpen ? "rotate-90" : ""}`}
              />
              {moreLinkCount} more {moreLinkCount === 1 ? "link" : "links"}
            </GhostButton>
            {moreOpen ? (
              <div id="share-links-more-list" className="flex flex-col gap-3">
                {primaryGroup && primaryRest.length > 0 ? (
                  <div
                    data-testid={`share-link-rest-${primaryGroup.shareId}`}
                    className="flex flex-col gap-1"
                  >
                    {primaryRest.map((row) =>
                      renderLinkRow(
                        primaryGroup,
                        row,
                        isWorking(row) && eligibleShareIds.has(primaryGroup.shareId),
                      ),
                    )}
                  </div>
                ) : null}
                {moreGroups.map((group) => renderLinkGroup(group))}
                {createInMore ? createSection : null}
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    ) : null,
    people: peopleGroups.length > 0 ? <>{peopleGroups}</> : null,
    peopleGrantIds,
    close: closeDialog,
  };
}
