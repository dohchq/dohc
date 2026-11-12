import { ipcErrorMessage } from "./ipcError";
import { ChevronDown, MessageSquare, Plus, Sparkles } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import { AutomationShareNote, useAutomationShareCheck, type AutomationShare } from "./automationShareCheck";
import { DangerButton, GhostButton, PrimaryButton, SecondaryButton, SectionLabel } from "./ui/controls";
import { Menu } from "./ui/Menu";
import { MoreMenu } from "./ui/MoreMenu";
import { CopyButton, type CopySecret } from "./ui/CopyButton";
import { AgentLinkAppMenu } from "./agentLinkApps";
import { AGENT_ADDRESS_SECRET, LinkAgentsList, agentAddressFor, useLinkAgentDisconnects } from "./shareLinkAgents";

// The relay keeps a sealed copy of each link for its owner, so Share can
// copy the same link again.
const SHARE_LINK_SECRET: CopySecret = { what: "the share link", again: "Open Share to copy it again." };
import { SegmentedControl } from "./ui/SegmentedControl";
import { SkeletonRows } from "./ui/SkeletonRows";

type LinkAccess = "view" | "comment" | "edit";

export function linkRetuneLabels(widens: boolean, access: LinkAccess | undefined, previous: string | undefined) {
  if (access === "edit") return {action: "Turn on editing", pending: "Turning on editing…"};
  if (widens) return {action: "Turn on comments", pending: "Turning on comments…"};
  if (access === "view" && previous === "edit") return {action: "Turn off editing", pending: "Turning off editing…"};
  return access === "comment"
    ? {action: "Use Comment access", pending: "Changing access…"}
    : {action: "Turn off comments", pending: "Turning off comments…"};
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

const LINK_ACCESS_OPTIONS: ReadonlyArray<{
  value: LinkAccess;
  label: string;
}> = [
  { value: "view", label: "View" },
  { value: "comment", label: "Comment" },
  { value: "edit", label: "Edit" },
];

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

// The selection as the dialog names it, for notices about its links.
function targetLabel(target: RelayShareTarget): string {
  return target.kind === "version"
    ? `version “${target.versionName ?? target.versionId}”`
    : (target.label ?? target.paths.join(", "));
}

function rowMatchesTarget(row: RelayShareLinkRow, target: RelayShareTarget): boolean {
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
  const byId = new Map(
    merged.map((message) => [message.messageId, message] as const),
  );
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
      (left.messageId < right.messageId
        ? -1
        : left.messageId > right.messageId
          ? 1
          : 0),
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
  const currentById = new Map(
    current.map((message) => [message.messageId, message] as const),
  );
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
  return grant.recipientEmail ?? grant.recipientUserId ?? "Unknown recipient";
}

function dependentName(dependent: RelayShareLinkDependent): string {
  return dependent.recipientEmail ?? dependent.recipientUserId ?? "Unknown recipient";
}

function isDiscussionMutationAction(actionKey: string): boolean {
  return (
    actionKey === "pause" ||
    actionKey.startsWith("delete:") ||
    actionKey.startsWith("principal:")
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
        <code className="font-mono text-[11px] text-ink">
          {dependent.recipientUserId}
        </code>
      )}
    </span>
  ));
}

const LINK_ACCESS_WORDS: Record<LinkAccess, string> = {
  view: "Can view",
  comment: "Can comment",
  edit: "Can edit",
};

function linkAccessOf(access: string): LinkAccess | null {
  return access === "view" || access === "comment" || access === "edit" ? access : null;
}

function LinkAccessChoice(props: {
  supported: readonly LinkAccess[];
  access: LinkAccess;
  ariaLabel: string;
  disabled: boolean;
  onChange: (access: LinkAccess) => void;
}) {
  return (
    <SegmentedControl
      label={props.ariaLabel}
      value={props.access}
      options={LINK_ACCESS_OPTIONS.filter((option) =>
        props.supported.includes(option.value),
      )}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  );
}

const ACCESS_TRIGGER =
  "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-ink transition-colors enabled:hover:bg-hover disabled:text-subtle";

// A link's access, changed the way Docs and Notion change it: from the
// access itself. Picking a level opens the row's confirmation.
function LinkAccessMenu(props: {
  access: LinkAccess;
  supported: readonly LinkAccess[];
  disabled: boolean;
  testId: string;
  onPick: (access: LinkAccess) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      label="Access for this link"
      open={open}
      onOpenChange={setOpen}
      width={224}
      topLayer
      align="start"
      items={props.supported.map((access) => ({
        id: access,
        label: LINK_ACCESS_WORDS[access],
        checked: access === props.access,
        onSelect: () => props.onPick(access),
      }))}
      trigger={(trigger) => (
        <button {...trigger} type="button" data-testid={props.testId} disabled={props.disabled} className={ACCESS_TRIGGER}>
          {LINK_ACCESS_WORDS[props.access]}
          <ChevronDown size={12} aria-hidden className="text-subtle" />
        </button>
      )}
    />
  );
}

// Another link to the same share: same files, same comments. Picking its
// access adds it; an Edit link that stops automations asks once more.
function AddLinkMenu(props: {
  supported: readonly LinkAccess[];
  disabled: boolean;
  busyLabel: string | null;
  warned: boolean;
  onPick: (access: LinkAccess) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (props.busyLabel !== null) {
    return <SecondaryButton size="compact" disabled>{props.busyLabel}</SecondaryButton>;
  }
  if (props.warned) {
    return (
      <div className="flex items-center gap-2">
        <SecondaryButton size="compact" disabled={props.disabled} onClick={props.onCancel}>Cancel</SecondaryButton>
        <SecondaryButton size="compact" disabled={props.disabled} onClick={props.onConfirm}>Add link anyway</SecondaryButton>
      </div>
    );
  }
  return (
    <Menu
      label="Access for the new link"
      open={open}
      onOpenChange={setOpen}
      width={224}
      topLayer
      items={props.supported.map((access) => ({
        id: access,
        label: LINK_ACCESS_WORDS[access],
        onSelect: () => props.onPick(access),
      }))}
      trigger={(trigger) => (
        <GhostButton {...trigger} disabled={props.disabled}>
          <Plus size={13} aria-hidden />
          Add link
        </GhostButton>
      )}
    />
  );
}

export function useRelayShareLinkPane(props: {
  workspaceId: string;
  target: RelayShareTarget;
  visible: boolean;
  onClose: () => void;
  // Ending a link or a person's access is undoable for a while. The shell
  // shows that notice and holds the Undo, so it outlives this dialog; a
  // refused removal goes to the same shell with Try again.
  shareRemovals?: ShareRemovalNotices;
  // The shell's useDisconnectedLinkAgents set.
  disconnectedAgents?: ReadonlySet<string>;
}): {
  content: ReactNode;
  scope: string;
  close: () => void;
} {
  // The dialog's Disconnects outlive the link tab, so leaving it does not
  // count as closing the dialog.
  const agentDisconnects = useLinkAgentDisconnects(props.shareRemovals, props.disconnectedAgents);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkRequestBusy, setLinkRequestBusy] = useState<LinkRequestBusy | null>(
    null,
  );
  const [supportedLinkAccess, setSupportedLinkAccess] = useState<readonly LinkAccess[]>(["view", "comment"]);
  const availableLinkAccess = props.target.kind === "version" ? supportedLinkAccess.filter(access => access !== "edit") : supportedLinkAccess;
  const [linkAccess, setLinkAccess] = useState<LinkAccess>("view");
  const automationCheck = useAutomationShareCheck(props.workspaceId, props.target);
  const newLinkNote = automationCheck.noteFor({ recipientEmail: null, access: linkAccess });
  const [addAccessByShareId, setAddAccessByShareId] = useState<
    Record<string, LinkAccess>
  >({});
  const [linkError, setLinkError] = useState<string | null>(null);
  const [separateOpen, setSeparateOpen] = useState(false);
  const [minted, setMinted] = useState<{ grantId: string; url: string } | null>(null);
  const [links, setLinks] = useState<RelayShareLinkRow[]>([]);
  // A read of the links that changes them reads each link's agents again. A
  // list reads once when it mounts, so returning to the tab reads it once.
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
  const [independentGrants, setIndependentGrants] = useState<
    RelayShareLinkIndependentGrant[]
  >([]);
  const [ownerAppendBusy, setOwnerAppendBusy] = useState<string | null>(null);
  const [ownerMutationBusy, setOwnerMutationBusy] =
    useState<OwnerMutationBusy | null>(null);
  const [ownerMutationError, setOwnerMutationError] =
    useState<OwnerMutationBusy | null>(null);
  const [ownerConfirmation, setOwnerConfirmation] =
    useState<OwnerConfirmation | null>(null);
  const linkScopeGeneration = useRef(0);
  const latestMintRequest = useRef(0);
  const latestInventoryRequest = useRef(0);
  const latestMutationRequest = useRef(0);
  const latestDiscussionRequestByShareId = useRef(new Map<string, number>());
  const activeFullDiscussionRequestByShareId = useRef(new Map<string, symbol>());
  const pendingDiscussionReconciliationByShareId = useRef(new Set<string>());
  const latestActivityGenerationByShareId = useRef(new Map<string, number>());
  const ownerActivityByShareId = useRef(new Map<string, OwnerActivityControl>());
  const ownerDiscussionMessagesByShareId = useRef(
    new Map<string, RelayShareDiscussionMessage[]>(),
  );
  const expandedOwnerShareIdsRef = useRef(new Set<string>());
  const latestOwnerAppendRequest = useRef(0);
  const latestOwnerMutationRequest = useRef(0);
  const activeOwnerAppendShareId = useRef<string | null>(null);
  const activeOwnerMutationShareId = useRef<string | null>(null);
  const eligibleShareIdsRef = useRef<Set<string>>(new Set());

  const targetKey =
    props.target.kind === "version"
      ? JSON.stringify(["version", props.target.versionId])
      : JSON.stringify(["paths", ...normalizedPathSet(props.target.paths)]);
  const linkScope = JSON.stringify([props.workspaceId, targetKey]);

  const visibleLinks = useMemo(() => {
    const readable = links.filter((row) => rowMatchesTarget(row, props.target));
    return [
      ...readable.filter((row) => row.status === "active"),
      ...readable.filter((row) => row.status === "revoked"),
      ...links.filter((row) => row.selector === null && row.status === "active"),
    ];
  }, [links, targetKey]);

  const visibleLinkGroups = useMemo(
    () => groupLinksByShareId(visibleLinks),
    [visibleLinks],
  );
  const hasMatchingShare = visibleLinkGroups.some((group) =>
    group.rows.some((row) => rowMatchesTarget(row, props.target)),
  );
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
    ? visibleLinks.find(
        (row) =>
          row.status === "active" &&
          row.shareId === confirmation.shareId &&
          row.grantId === confirmation.grantId,
      ) ?? null
    : null;
  const narrowerDependents =
    confirmation?.kind === "retune"
      ? (confirmationRow?.dependents.filter(
          (dependent) =>
            shareAccessRank(dependent.access) > shareAccessRank(confirmation.access),
        ) ?? [])
      : [];
  const confirmationWidens =
    confirmation?.kind === "retune" && confirmationRow !== null &&
    shareAccessRank(confirmation.access) > shareAccessRank(confirmationRow.access);
  const retuneLabels = linkRetuneLabels(confirmationWidens, confirmation?.kind === "retune" ? confirmation.access : undefined, confirmationRow?.access);
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
    setSupportedLinkAccess(["view", "comment"]);
    setAddAccessByShareId({});
    setLinkError(null);
    setMinted(null);
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
      for (const [
        shareId,
        requestId,
      ] of latestDiscussionRequestByShareId.current) {
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
      Object.fromEntries(
        Object.entries(current).filter(([shareId]) => nextEligible.has(shareId)),
      ),
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
    const requestId =
      (latestDiscussionRequestByShareId.current.get(shareId) ?? 0) + 1;
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
    const generation =
      (latestActivityGenerationByShareId.current.get(shareId) ?? 0) + 1;
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

  function isCurrentOwnerActivity(
    control: OwnerActivityControl,
    pollId?: string,
  ): boolean {
    return (
      isCurrentLinkScope(control.scopeGeneration) &&
      control.workspaceId === props.workspaceId &&
      latestActivityGenerationByShareId.current.get(control.shareId) ===
        control.generation &&
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
        principalBlockedById.set(
          principal.principalId,
          principal.blocked,
        );
      }

      const mergedMessages = mergeDiscussionMessages(
        ownerDiscussionMessagesByShareId.current.get(control.shareId) ?? [],
        result.messages,
      );
      if (mergedMessages === null) {
        throw new Error("Invalid discussion activity messages");
      }
      const messages = applyDiscussionPrincipalOverrides(
        mergedMessages,
        principalBlockedById,
      );
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

  function startOwnerActivity(
    shareId: string,
    revision: number,
    scopeGeneration: number,
  ) {
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
    if (
      !isCurrentLinkScope(scopeGeneration) ||
      !eligibleShareIdsRef.current.has(shareId)
    ) {
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
    const reconciliationPending =
      pendingDiscussionReconciliationByShareId.current.has(shareId);
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
      const currentMessages =
        ownerDiscussionMessagesByShareId.current.get(shareId) ?? [];
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
          ? applyDiscussionPrincipalOverrides(
              mergedMessages,
              activityControl.principalBlockedById,
            )
          : mergedMessages;
      ownerDiscussionMessagesByShareId.current.set(shareId, messages);
      updateOwnerDiscussion(shareId, (current) => {
        return {
          ...current,
          loaded: true,
          loading: false,
          paging: false,
          reconciliationPending:
            cursor === undefined ? false : current.reconciliationPending,
          activityRevision:
            cursor === undefined ? result.activityRevision : current.activityRevision,
          linkCommentsPaused:
            cursor === undefined
              ? result.linkCommentsPaused
              : current.linkCommentsPaused,
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
          current?.shareId === shareId &&
          isDiscussionMutationAction(current.actionKey)
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
      setOwnerConfirmation((current) =>
        current?.shareId === shareId ? null : current,
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
      if (
        !isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerAppendRequest,
          shareId,
        )
      ) {
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
      if (
        !isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerAppendRequest,
          shareId,
        )
      ) {
        return;
      }
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        appendError: true,
      }));
    } finally {
      if (
        isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerAppendRequest,
          shareId,
        )
      ) {
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
      if (
        !isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerMutationRequest,
          shareId,
        )
      ) {
        return;
      }
      setOwnerConfirmation(null);
      if (refresh === "discussion") {
        void refreshOwnerDiscussion(shareId, undefined, scopeGeneration);
      } else {
        void refreshLinks(scopeGeneration);
      }
    } catch {
      if (
        !isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerMutationRequest,
          shareId,
        )
      ) {
        return;
      }
      setOwnerConfirmation(null);
      // A refused removal is already in the shell's notices, with Try again.
      if (!(props.shareRemovals && actionKey.startsWith("revoke:"))) {
        setOwnerMutationError({ shareId, actionKey });
      }
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
      if (
        isCurrentOwnerRequest(
          scopeGeneration,
          requestId,
          latestOwnerMutationRequest,
          shareId,
        )
      ) {
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
    const scopeGeneration = linkScopeGeneration.current;
    void runOwnerMutation(
      action.shareId,
      `revoke:${action.grantId}`,
      () => endNamedAccess(action, scopeGeneration),
      "inventories",
    );
  }

  // Ends one person's access and reports it to the shell. Try again on a
  // refusal runs this directly: the dialog may be gone by then, and the
  // owner mutation gate only admits shares the open dialog still lists.
  async function endNamedAccess(
    action: Extract<OwnerConfirmation, { kind: "revoke" }>,
    scopeGeneration: number,
  ) {
    const subject = `${action.name}'s access to ${targetLabel(props.target)}`;
    try {
      const result = await bridge().revokeRelayShareGrant({
        workspaceId: props.workspaceId,
        shareId: action.shareId,
        grantId: action.grantId,
      });
      props.shareRemovals?.removed({
        workspaceId: props.workspaceId,
        shareId: action.shareId,
        undo: result.undo,
        message: `Ended ${subject}.`,
        restoredMessage: `Restored ${subject}.`,
        restored: () => {
          if (isCurrentLinkScope(scopeGeneration)) void refreshLinks(scopeGeneration);
        },
      });
      return result;
    } catch (cause) {
      props.shareRemovals?.failed({
        workspaceId: props.workspaceId,
        message: `dohc could not end ${subject}.`,
        cause,
        retry: () => {
          void endNamedAccess(action, scopeGeneration).then(
            () => {
              if (isCurrentLinkScope(scopeGeneration)) void refreshLinks(scopeGeneration);
            },
            () => undefined,
          );
        },
      });
      throw cause;
    }
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
      const independentInventory = new Map<
        string,
        RelayShareLinkIndependentGrant
      >();
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
            ...(independentGrantCursor
              ? { independentGrantCursor }
              : {}),
          });
          if (
            !isCurrentLinkScope(scopeGeneration) ||
            latestInventoryRequest.current !== requestId
          ) {
            return;
          }
          if (advertisedAccess && advertisedAccess.join() !== result.supportedLinkAccess.join()) throw new Error("dohc could not load consistent link permissions. Retry.");
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
          if (
            seenIndependentGrantCursors.has(
              result.nextIndependentGrantCursor,
            )
          ) {
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
      setLinkAccess(current => advertisedAccess!.includes(current) ? current : "view");
      setAddAccessByShareId(current => Object.fromEntries(Object.entries(current).map(([id, access]) => [id, advertisedAccess!.includes(access) ? access : "view"])));
      setLinks(inventory);
      const key = JSON.stringify(inventory);
      if (linksKey.current !== key) {
        linksKey.current = key;
        setLinksRevision((revision) => revision + 1);
      }
      setIndependentGrants([...independentInventory.values()]);
      if (!options.preserveOwnerMutationError) {
        setOwnerMutationError((current) =>
          current !== null && isGrantMutationAction(current.actionKey)
            ? null
            : current,
        );
      }
      setConfirmation((current) =>
        current !== null &&
        ((current.kind === "retune" && !advertisedAccess!.includes(current.access)) || !inventory.some(
          (row) =>
            row.status === "active" &&
            row.shareId === current.shareId &&
            row.grantId === current.grantId,
        ))
          ? null
          : current,
      );
    } catch (cause) {
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestInventoryRequest.current !== requestId
      ) {
        return;
      }
      setIndependentGrants([]);
      setSupportedLinkAccess(["view", "comment"]);
      setLinkAccess("view");
      setAddAccessByShareId({});
      setLinksError(ipcErrorMessage(cause));
    } finally {
      if (
        isCurrentLinkScope(scopeGeneration) &&
        latestInventoryRequest.current === requestId
      ) {
        setLinksLoading(false);
      }
    }
  }

  async function mintLink(
    action: LinkRequestBusy,
    request: () => Promise<MintedLinkResult>,
  ) {
    if (linkBusy || mutationBusy !== null || confirmation !== null) return;
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestMintRequest.current;

    setLinkBusy(true);
    setLinkRequestBusy(action);
    setLinkError(null);
    setMinted(null);

    try {
      const result = await request();
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMintRequest.current !== requestId
      ) {
        return;
      }
      setMinted({ grantId: result.grantId, url: result.url });
      void refreshLinks(scopeGeneration);
    } catch (cause) {
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMintRequest.current !== requestId
      ) {
        return;
      }
      setLinkError(ipcErrorMessage(cause));
      void refreshLinks(scopeGeneration);
    } finally {
      if (
        isCurrentLinkScope(scopeGeneration) &&
        latestMintRequest.current === requestId
      ) {
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
      payload = {workspaceId: props.workspaceId, versionId: props.target.versionId, access: linkAccess};
    } else {
      payload = {workspaceId: props.workspaceId, paths: props.target.paths, access: linkAccess};
    }
    if (!(await checkAutomations({ recipientEmail: null, access: linkAccess }))) return;
    await mintLink({ kind: "create" }, () => bridge().createRelayShareLink(payload));
  }

  async function addLink(shareId: string, access: LinkAccess) {
    if (!(await checkAutomations({ recipientEmail: null, access, shareId }))) return;
    await mintLink({ kind: "add", shareId }, () =>
      bridge().addRelayShareLink({
        workspaceId: props.workspaceId,
        shareId,
        access,
      }),
    );
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
    const retiresDisplayedCredential =
      minted?.grantId === row.grantId &&
      (action.kind === "reset" ||
        action.kind === "end" ||
        (action.kind === "retune" &&
          shareAccessRank(action.access) > shareAccessRank(row.access)));
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
          message: "Access through this link changed. Open Share and check who has access before ending the link.",
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
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMutationRequest.current !== requestId
      ) {
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
          "Who has access through this link changed. Check the updated names and confirm again.",
        );
        void refreshLinks(scopeGeneration);
        return;
      }

      if (result.outcome === "rotated" || result.outcome === "widened") {
        setMinted({ grantId: row.grantId, url: result.url });
      } else if (result.outcome !== "narrowed") {
        setMinted((current) =>
          current?.grantId === row.grantId ? null : current,
        );
      }
      if (action.kind === "retune" &&
          (result.outcome === "widened" || result.outcome === "narrowed")) {
        setLinks((current) =>
          current.map((currentRow) =>
            currentRow.shareId === row.shareId && currentRow.grantId === row.grantId
              ? { ...currentRow, access: action.access }
              : currentRow,
          ),
        );
      }
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
      if (!isCurrentLinkScope(scopeGeneration) || latestMutationRequest.current !== requestId) return;
      if (retiresDisplayedCredential) {
        setMinted(null);
      }
      if (action.kind !== "end" || !props.shareRemovals) setLifecycleError(ipcErrorMessage(cause));
      setConfirmation(null);
      void refreshLinks(scopeGeneration);
    } finally {
      if (
        isCurrentLinkScope(scopeGeneration) &&
        latestMutationRequest.current === requestId
      ) {
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
    if (linkBusy || mutationBusy !== null || row.status !== "active" || row.access === access) return;
    setLifecycleError(null);
    setConfirmation({ kind: "retune", shareId: row.shareId, grantId: row.grantId, access });
  }

  const linkControlsBusy = linkBusy || mutationBusy !== null || confirmation !== null;

  function renderLinkConfirmation(row: RelayShareLinkRow) {
    if (!confirmation) return null;
    return (
      <div
        data-testid="share-link-confirmation"
        className="flex flex-col gap-3 rounded-lg bg-panel-2 p-3"
      >
        <p className="m-0 text-[13px] leading-relaxed text-ink">
          {confirmation.kind === "retune" ? (
            confirmationWidens ? (
              <>
                {confirmation.access === "edit" ? "Turn on editing for this link?" : "Turn on comments for this link?"}{" "}
                The current link stops working right away, and you get a new link to send.
                Published apps stop working until you review and publish them again.
                {row.dependents.length > 0 ? (
                  <>
                    {" "}People who joined through it keep access and stay at
                    their current level: <DependentNames dependents={row.dependents} />.
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
                    ? "Turn off editing for this link? The same link keeps working. Holders can view and comment."
                    : "Use Comment access for this link? The same link keeps working. Holders can view and comment."}
                {narrowerDependents.length > 0 ? (
                  <>
                    {" "}These people drop to {confirmation.access === "comment" ? "Comment" : "view"} too:{" "}
                    <DependentNames dependents={narrowerDependents} />.
                  </>
                ) : null}
              </>
            )
          ) : confirmation.kind === "reset" ? (
            <>
              Reset this link? The current link stops working right away, and you get a
              new link to send. Published apps stop working until you review and publish them again.
              {row.dependents.length > 0 ? (
                <>
                  {" "}People who joined through it keep access:{" "}
                  <DependentNames dependents={row.dependents} />. To
                  remove them, end the link instead.
                </>
              ) : null}
            </>
          ) : row.dependents.length === 0 ? (
            <>
              End this link? It stops working right away. Copies people already made
              stay with them.
            </>
          ) : (
            <>
              End this link? It stops working right away, and these people lose
              access through it: <DependentNames dependents={row.dependents} />.
              Copies they already made stay with them.
            </>
          )}
        </p>
        <div className="flex justify-end gap-2">
          <SecondaryButton
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

  function renderLinkUrl(url: string) {
    const agentAddress = agentAddressFor(url);
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-line bg-bg px-3 font-mono text-[12px] text-muted">
            <code data-testid="share-link-url" title={url} className="min-w-0 select-text truncate">{url}</code>
          </div>
          {/* Keyed by the link, so a reset link is a new control. */}
          <CopyButton
            key={url}
            size="button"
            label="Copy link"
            getText={() => url}
            sensitive={SHARE_LINK_SECRET}
            testId="share-link-copy"
          />
        </div>
        {/* The same link, at the address an agent signs in with. */}
        {agentAddress !== null ? (
          <div className="flex items-center gap-1">
            <CopyButton
              key={`agent:${url}`}
              size="header"
              icon={Sparkles}
              label="Copy for an agent"
              getText={() => agentAddressFor(url)}
              sensitive={AGENT_ADDRESS_SECRET}
              testId="share-link-agent-copy"
            />
            <AgentLinkAppMenu
              key={`apps:${url}`}
              link={agentAddress}
              server="dohc-share"
              sensitive={AGENT_ADDRESS_SECRET}
              testId="share-link-agent-apps"
            />
          </div>
        ) : null}
      </div>
    );
  }

  function renderLinkRow(group: LinkGroup, row: RelayShareLinkRow) {
    const damaged = row.selector === null;
    const active = row.status === "active";
    const access = linkAccessOf(row.access);
    const retuneTo = !damaged && access !== null
      ? (row.selector?.versionId === null ? availableLinkAccess : availableLinkAccess.filter((option) => option !== "edit"))
      : [];
    const canReset = !damaged && (row.access !== "edit" || (availableLinkAccess.includes("edit") && row.selector?.versionId === null));
    // A link made or reset in this dialog is the one to send now; every
    // other active link shows the copy the relay keeps for its owner.
    const url = !active || damaged ? null : minted?.grantId === row.grantId ? minted.url : row.url;
    const used = row.lastUsedAtMs === null ? "Not used yet" : `Used ${shortTimestamp.format(row.lastUsedAtMs)}`;
    const issued = row.urlIssuedAtMs !== null && row.urlIssuedAtMs > row.createdAtMs
      ? ` · Link reset ${shortDate.format(row.urlIssuedAtMs)}`
      : "";
    const confirming = confirmation !== null && confirmationRow?.grantId === row.grantId;
    return (
      <article
        key={row.grantId}
        data-testid={`share-link-row-${row.grantId}`}
        data-status={row.status}
        className="flex flex-col gap-2 border-t border-line px-3 py-3 first:border-t-0"
      >
        {damaged ? (
          <div className="flex min-h-7 items-center gap-2">
            <p className="m-0 min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
              Unreadable link. dohc can't read what this link shares.
            </p>
            {active ? (
              <MoreMenu
                label="Link options"
                topLayer
                testId={`share-link-options-${row.grantId}`}
                items={[{ label: "End link", danger: true, disabled: linkBusy || mutationBusy !== null, onSelect: () => openConfirmation("end", row) }]}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-7 items-center gap-2">
            {active && access !== null && retuneTo.length > 1 ? (
              <LinkAccessMenu
                access={access}
                supported={retuneTo}
                disabled={linkBusy || mutationBusy !== null}
                testId={`share-link-access-${row.grantId}`}
                onPick={(next) => pickLinkAccess(row, next)}
              />
            ) : (
              <span className="flex h-7 shrink-0 items-center rounded-md px-2 text-[12px] font-medium text-ink">
                {access === null ? row.access : LINK_ACCESS_WORDS[access]}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate text-[12px] text-subtle">
              {active
                ? `${used} · Created ${shortDate.format(row.createdAtMs)}${issued}`
                : `Ended ${shortDate.format(row.revokedAtMs ?? row.createdAtMs)}`}
            </span>
            {active ? (
              <MoreMenu
                label="Link options"
                topLayer
                testId={`share-link-options-${row.grantId}`}
                items={[
                  ...(canReset ? [{ label: "Reset link", disabled: linkBusy || mutationBusy !== null, onSelect: () => openConfirmation("reset", row) }] : []),
                  { label: "End link", danger: true, disabled: linkBusy || mutationBusy !== null, onSelect: () => openConfirmation("end", row) },
                ]}
              />
            ) : null}
          </div>
        )}

        {url !== null ? (
          renderLinkUrl(url)
        ) : active && !damaged ? (
          <p data-testid="share-link-no-copy" className="m-0 text-[12px] leading-relaxed text-muted">
            dohc has no copy of this link. Reset it to get a link you can copy.
          </p>
        ) : null}

        {confirming ? renderLinkConfirmation(row) : null}

        {active && !damaged ? (
          <LinkAgentsList
            key={`${props.workspaceId}:${group.shareId}:${row.grantId}`}
            workspaceId={props.workspaceId}
            shareId={group.shareId}
            grantId={row.grantId}
            revision={linksRevision}
            disconnects={agentDisconnects}
          />
        ) : null}
      </article>
    );
  }

  function renderOwnerConfirmation(pending: OwnerConfirmation) {
    return (
      <div
            data-testid="owner-comments-confirmation"
            className="flex flex-col gap-3 rounded-lg bg-panel-2 p-3"
          >
            <p className="m-0 text-[13px] leading-relaxed text-ink">
              {pending.kind === "delete"
                ? "Delete this comment? Its text is removed for everyone right away and can't be brought back. Readers see that a comment was deleted."
                : pending.kind === "block"
                  ? `Block ${pending.name}? They can't comment through this link from this browser until you unblock them. They can still comment from another browser or another link. To stop everyone with this link, reset it.`
                  : pending.kind === "promote"
                    ? `Make ${pending.name}'s access independent of this link? This is permanent. Resetting or ending the link no longer affects their access. You can end their access here at any time.`
                    : `End ${pending.name}'s access? They lose access right away. Copies they already made stay with them.`}
            </p>
            <div className="flex justify-end gap-2">
              <SecondaryButton
                disabled={ownerMutationBusy !== null}
                onClick={() => setOwnerConfirmation(null)}
              >
                Cancel
              </SecondaryButton>
              <OwnerConfirm
                disabled={ownerMutationBusy !== null}
                aria-busy={ownerMutationBusy !== null}
                onClick={() =>
                  executeOwnerConfirmation(pending)
                }
              >
                {pending.kind === "delete"
                  ? "Delete comment"
                  : pending.kind === "block"
                    ? "Block"
                    : pending.kind === "promote"
                      ? "Make independent"
                      : "End access"}
              </OwnerConfirm>
            </div>
          </div>
    );
  }

  function renderPeople(group: LinkGroup) {
    const displayedDependentIds = new Set(
      group.rows.flatMap((row) =>
        row.status === "active"
          ? row.dependents.map((dependent) => dependent.grantId)
          : [],
      ),
    );
    const shareIndependentGrants = independentGrants.filter(
      (grant) =>
        grant.shareId === group.shareId &&
        grant.recipientUserId !== null &&
        !displayedDependentIds.has(grant.grantId),
    );
    const linkedPeople = group.rows.flatMap((row) =>
      row.status === "active"
        ? row.dependents
            .filter((dependent) => dependent.recipientUserId !== null)
            .map((dependent) => ({ row, dependent }))
        : [],
    );
    if (linkedPeople.length === 0 && shareIndependentGrants.length === 0) return null;
    return (
      <div className="flex flex-col gap-2 border-t border-line px-3 py-3">
          <section aria-labelledby={`share-people-heading-${group.shareId}`} className="flex flex-col gap-1">
            <SectionLabel as="h4" id={`share-people-heading-${group.shareId}`} className="m-0">
              People
            </SectionLabel>
            {linkedPeople.map(({ row, dependent }) => {
              const actionKey = `promote:${dependent.grantId}`;
              return (
                <div
                  key={`${row.grantId}:${dependent.grantId}`}
                  data-testid={`share-dependent-${dependent.grantId}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex min-h-8 items-center justify-between gap-3">
                    <span className="flex min-w-0 flex-col">
                      <span className="break-all text-[13px] text-ink">{dependentName(dependent)}</span>
                      <span className="text-[12px] text-subtle">Joined through a link</span>
                    </span>
                    <SecondaryButton
                      size="compact"
                      disabled={ownerMutationBusy !== null}
                      onClick={() => {
                        setOwnerConfirmation({
                          kind: "promote",
                          shareId: group.shareId,
                          grantId: dependent.grantId,
                          parentGrantId: row.grantId,
                          parentGeneration: row.generation,
                          name: dependentName(dependent),
                        });
                      }}
                    >
                      Make independent
                    </SecondaryButton>
                  </div>
                  {ownerMutationError?.shareId === group.shareId &&
                  ownerMutationError.actionKey === actionKey ? (
                    <p role="alert" className="m-0 text-[12px] text-danger">
                      dohc could not complete that change.
                    </p>
                  ) : null}
                </div>
              );
            })}
            {shareIndependentGrants.map((grant) => {
              const actionKey = `revoke:${grant.grantId}`;
              return (
                <div
                  key={grant.grantId}
                  data-testid={`share-independent-${grant.grantId}`}
                  className="flex flex-col gap-1"
                >
                  <div className="flex min-h-8 items-center justify-between gap-3">
                    <span className="min-w-0 break-all text-[13px] text-ink">
                      {namedGrantName(grant)}
                    </span>
                    <SecondaryButton
                      size="compact"
                      disabled={ownerMutationBusy !== null}
                      onClick={() => {
                        setOwnerConfirmation({
                          kind: "revoke",
                          shareId: group.shareId,
                          grantId: grant.grantId,
                          name: namedGrantName(grant),
                        });
                      }}
                    >
                      End access
                    </SecondaryButton>
                  </div>
                  {ownerMutationError?.shareId === group.shareId &&
                  ownerMutationError.actionKey === actionKey ? (
                    <p role="alert" className="m-0 text-[12px] text-danger">
                      dohc could not complete that change.
                    </p>
                  ) : null}
                </div>
              );
            })}
          </section>
        {ownerConfirmation?.shareId === group.shareId &&
        (ownerConfirmation.kind === "promote" || ownerConfirmation.kind === "revoke")
          ? renderOwnerConfirmation(ownerConfirmation)
          : null}
      </div>
    );
  }

  function renderOwnerDiscussion(group: LinkGroup) {
    const ownerDiscussion =
      ownerDiscussionByShareId[group.shareId] ?? emptyOwnerDiscussion();
    const ownerDraftInvalid =
      ownerDiscussion.draft.length > 0 &&
      normalizeShareDiscussionBody(ownerDiscussion.draft) === null;
    const showOwnerAppendRetry =
      ownerDiscussion.appendError && !ownerDraftInvalid;
    const ownerDraftErrorId = `share-comment-body-error-${group.shareId}`;
    return (
      <div className="flex flex-col gap-3 border-t border-line px-3 py-3">
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
            {ownerDiscussion.linkCommentsPaused
              ? "Resume link comments"
              : "Pause link comments"}
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
            <p role="status" className="m-0 text-[12px] text-muted">Loading comments…</p>
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
                  ? [{
                      label: "Delete comment",
                      disabled: ownerMutationBusy !== null,
                      onSelect: () => setOwnerConfirmation({ kind: "delete", shareId: group.shareId, messageId: message.messageId }),
                    }]
                  : []),
                ...(linkAuthored
                  ? [message.moderation.blocked
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
                        }]
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
                  <p className={`m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed ${message.deleted ? "text-subtle" : "text-ink"}`}>
                    {message.deleted
                      ? "Comment deleted by the owner"
                      : message.body}
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
              void refreshOwnerDiscussion(
                group.shareId,
                ownerDiscussion.nextCursor ?? undefined,
              )
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
            aria-describedby={
              ownerDraftInvalid ? ownerDraftErrorId : undefined
            }
            rows={2}
            onChange={(event) => {
              const draft = event.currentTarget.value.replaceAll(
                "\u0000",
                "",
              );
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
            <p
              id={ownerDraftErrorId}
              role="alert"
              className="m-0 text-[12px] text-danger"
            >
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
                (!showOwnerAppendRetry &&
                  ownerDiscussion.draft.length === 0)
              }
              aria-busy={ownerAppendBusy === group.shareId}
              onClick={() =>
                void appendOwnerComment(
                  group.shareId,
                  showOwnerAppendRetry,
                )
              }
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

  function renderLinkGroup(group: LinkGroup) {
    const canAdd = eligibleShareIds.has(group.shareId);
    const addAccess = addAccessByShareId[group.shareId] ?? "view";
    const addNote = automationCheck.noteFor({ recipientEmail: null, access: addAccess, shareId: group.shareId });
    const ownerDiscussion =
      ownerDiscussionByShareId[group.shareId] ?? emptyOwnerDiscussion();
    const addSupported = group.rows.some((row) => row.selector?.versionId !== null)
      ? availableLinkAccess.filter((access) => access !== "edit")
      : availableLinkAccess;
    return (
      <div
        key={group.shareId}
        data-testid={`share-link-group-${group.shareId}`}
        className="flex flex-col rounded-lg border border-line bg-panel"
      >
        {group.rows.map((row) => renderLinkRow(group, row))}

        {canAdd ? renderPeople(group) : null}

        {canAdd ? (
          <div className="flex flex-col gap-2 border-t border-line px-3 py-2">
            <div className="flex items-center gap-2">
              <GhostButton
                aria-expanded={ownerDiscussion.expanded}
                onClick={() => toggleOwnerDiscussion(group.shareId)}
              >
                <MessageSquare size={13} aria-hidden />
                Comments
              </GhostButton>
              <span className="flex-1" />
              <AddLinkMenu
                supported={addSupported}
                disabled={linkControlsBusy}
                busyLabel={
                  linkRequestBusy?.kind === "check" && linkRequestBusy.shareId === group.shareId
                    ? "Checking automations…"
                    : linkRequestBusy?.kind === "add" && linkRequestBusy.shareId === group.shareId
                      ? "Adding link…"
                      : null
                }
                warned={Boolean(addNote?.warning)}
                onPick={(nextAccess) => {
                  if (nextAccess !== addAccess) {
                    setAddAccessByShareId((current) => ({ ...current, [group.shareId]: nextAccess }));
                  }
                  void addLink(group.shareId, nextAccess);
                }}
                onConfirm={() => void addLink(group.shareId, addAccess)}
                onCancel={() => setAddAccessByShareId((current) => ({ ...current, [group.shareId]: "view" }))}
              />
            </div>
            <AutomationShareNote note={addNote} />
          </div>
        ) : null}

        {canAdd && ownerDiscussion.expanded ? renderOwnerDiscussion(group) : null}
      </div>
    );
  }

  const createLabel =
    linkRequestBusy?.kind === "check" && linkRequestBusy.shareId === null
      ? "Checking automations…"
      : linkRequestBusy?.kind === "create"
        ? "Creating link…"
        : newLinkNote?.warning
          ? "Create link anyway"
          : hasMatchingShare
            ? "Create separate link"
            : "Create link";
  const CreateButton = hasMatchingShare && !newLinkNote?.warning ? SecondaryButton : PrimaryButton;

  // Once this selection has a share, another link is added to it from its
  // card; a separate share is the rarer choice, one step further away.
  const separateHidden =
    hasMatchingShare && !separateOpen && !newLinkNote?.warning && linkRequestBusy?.kind !== "create" && linkError === null;

  const createSection = separateHidden ? (
    <GhostButton
      aria-expanded={false}
      className="self-start"
      disabled={linkControlsBusy}
      onClick={() => setSeparateOpen(true)}
    >
      <Plus size={13} aria-hidden />
      Create separate link
    </GhostButton>
  ) : (
    <section aria-label="New link" className="flex flex-col gap-2">
      {hasMatchingShare ? (
        <div className="flex flex-col gap-1">
          <SectionLabel as="h3" className="m-0">Separate link</SectionLabel>
          <p className="m-0 text-[12px] leading-relaxed text-muted">
            Starts a new share with its own comments.
          </p>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <LinkAccessChoice
            supported={availableLinkAccess}
            access={linkAccess}
            ariaLabel="Link access"
            disabled={linkControlsBusy}
            onChange={setLinkAccess}
          />
        </div>
        <CreateButton
          type="button"
          data-testid="share-link-create"
          className="shrink-0"
          disabled={linkControlsBusy}
          onClick={() => void createLink()}
        >
          {createLabel}
        </CreateButton>
      </div>
      {linkAccess === "edit" ? (
        <p className="m-0 text-[12px] leading-relaxed text-subtle">
          People who can edit can see the full History.
        </p>
      ) : null}
      <AutomationShareNote note={newLinkNote} />
      {linkError ? (
        <p data-testid="share-link-error" role="alert" className="m-0 text-[12px] text-danger">
          {linkError}
        </p>
      ) : null}
      {hasMatchingShare ? null : (
        <p className="m-0 text-[12px] leading-relaxed text-muted">
          Anyone with the link can open it without an account.{" "}
          {props.target.kind === "version"
            ? "The link shows this version as it is now."
            : "If files are added to this selection later, the link includes them."}{" "}
          The sync relay serves the link, so it can read this content.
        </p>
      )}
    </section>
  );

  // A new link shows at once, before the list that holds it reads again.
  const mintedElsewhere =
    minted !== null && !visibleLinks.some((row) => row.grantId === minted.grantId && row.status === "active");

  return {
    content: props.visible ? (
      <>
        {mintedElsewhere ? (
          <div data-testid="share-link-new" className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3">
            {renderLinkUrl(minted.url)}
          </div>
        ) : null}
        {visibleLinkGroups.length || linksLoading || linksError || lifecycleError ? (
          <section className="flex flex-col gap-2" aria-labelledby="share-links-heading">
            <SectionLabel as="h3" id="share-links-heading" className="m-0">
              Links
            </SectionLabel>

            {/* Lines stand in only for links not yet shown; a refresh keeps the
                links on screen and says so. */}
            {linksLoading ? (
              visibleLinkGroups.length ? (
                <p role="status" className="sr-only">Loading links…</p>
              ) : (
                <SkeletonRows rows={2} label="Loading links…" />
              )
            ) : null}

            {linksError ? (
              <div className="flex items-center justify-between gap-3">
                <p role="alert" className="m-0 min-w-0 text-[12px] text-danger">
                  {linksError}
                </p>
                <SecondaryButton size="compact" onClick={() => void refreshLinks()}>Try again</SecondaryButton>
              </div>
            ) : null}

            {lifecycleError ? (
              <p role="alert" className="m-0 text-[12px] leading-relaxed text-danger">
                {lifecycleError}
              </p>
            ) : null}

            {visibleLinkGroups.map((group) => renderLinkGroup(group))}
          </section>
        ) : null}

        {createSection}
      </>
    ) : null,
    scope: linkScope,
    close: closeDialog,
  };
}
