import { Check, Copy, Share2, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { normalizeShareDiscussionBody } from "@dohc/security-contract/share-discussion";
import type {
  CreateRelayShareLinkPayload,
  CreateRelaySharePayload,
  RelayShareDiscussionMessage,
  RelayShareLinkDependent,
  RelayShareLinkIndependentGrant,
  RelayShareLinkRow,
  ShareAccess,
} from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";

export type RelayShareTarget =
  | { kind: "paths"; paths: [string, ...string[]]; label?: string }
  | { kind: "version"; versionId: string; versionName?: string };

function errorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

const ACCESS_OPTIONS: ReadonlyArray<{
  value: ShareAccess;
  label: string;
  helper: string;
}> = [
  {
    value: "view",
    label: "View",
    helper: "They can read what you selected.",
  },
  {
    value: "edit",
    label: "Edit",
    helper: "They can read what you selected and send you changes to accept.",
  },
];

type ShareWith = "email" | "link";
type LinkAccess = "view" | "comment";

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
  | { kind: "add"; shareId: string };

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
): RelayShareDiscussionMessage[] {
  const byId = new Map(
    current.map((message) => [message.messageId, message] as const),
  );
  for (const message of incoming) {
    const existing = byId.get(message.messageId);
    if (existing?.deleted && !message.deleted) continue;
    byId.set(message.messageId, message);
  }
  return [...byId.values()].sort(
    (left, right) =>
      left.createdAtMs - right.createdAtMs ||
      (left.messageId < right.messageId
        ? -1
        : left.messageId > right.messageId
          ? 1
          : 0),
  );
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

function LinkAccessChoice(props: {
  access: LinkAccess;
  ariaLabel: string;
  disabled: boolean;
  onChange: (access: LinkAccess) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.ariaLabel}
      className="flex rounded-lg border border-line bg-panel-2 p-0.5"
    >
      {LINK_ACCESS_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={props.access === option.value}
          disabled={props.disabled}
          onClick={() => props.onChange(option.value)}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${
            props.access === option.value
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
}) {
  const [shareWith, setShareWith] = useState<ShareWith>("email");

  const [email, setEmail] = useState("");
  const [access, setAccess] = useState<ShareAccess>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{
    shareCode: string;
    recipientEmail: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  const [linkBusy, setLinkBusy] = useState(false);
  const [linkRequestBusy, setLinkRequestBusy] = useState<LinkRequestBusy | null>(
    null,
  );
  const [linkAccess, setLinkAccess] = useState<LinkAccess>("view");
  const [addAccessByShareId, setAddAccessByShareId] = useState<
    Record<string, LinkAccess>
  >({});
  const [linkError, setLinkError] = useState<string | null>(null);
  const [minted, setMinted] = useState<{ grantId: string; url: string } | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const [links, setLinks] = useState<RelayShareLinkRow[]>([]);
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
  const latestCopyRequest = useRef(0);
  const latestInventoryRequest = useRef(0);
  const latestMutationRequest = useRef(0);
  const latestDiscussionRequestByShareId = useRef(new Map<string, number>());
  const activeFullDiscussionRequestByShareId = useRef(new Map<string, symbol>());
  const pendingDiscussionReconciliationByShareId = useRef(new Set<string>());
  const latestActivityGenerationByShareId = useRef(new Map<string, number>());
  const ownerActivityByShareId = useRef(new Map<string, OwnerActivityControl>());
  const expandedOwnerShareIdsRef = useRef(new Set<string>());
  const latestOwnerAppendRequest = useRef(0);
  const latestOwnerMutationRequest = useRef(0);
  const activeOwnerAppendShareId = useRef<string | null>(null);
  const activeOwnerMutationShareId = useRef<string | null>(null);
  const eligibleShareIdsRef = useRef<Set<string>>(new Set());

  const subject =
    props.target.kind === "version"
      ? `version “${props.target.versionName ?? props.target.versionId}”`
      : (props.target.label ?? props.target.paths[0] ?? "this selection");

  const targetKey =
    props.target.kind === "version"
      ? JSON.stringify(["version", props.target.versionId])
      : JSON.stringify(["paths", ...normalizedPathSet(props.target.paths)]);
  const linkScope = JSON.stringify([props.workspaceId, targetKey]);

  const canSubmit = useMemo(() => email.trim().length > 2 && !busy, [busy, email]);

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
    confirmation?.kind === "retune" && confirmation.access === "view"
      ? (confirmationRow?.dependents.filter(
          (dependent) => dependent.access !== "view",
        ) ?? [])
      : [];
  const confirmationActionLabel =
    confirmation?.kind === "reset"
      ? "Reset link"
      : confirmation?.kind === "end"
        ? "End link"
        : confirmation?.access === "comment"
          ? "Turn on comments"
          : "Turn off comments";
  const confirmationPendingLabel =
    confirmation?.kind === "reset"
      ? "Resetting…"
      : confirmation?.kind === "end"
        ? "Ending…"
        : confirmation?.access === "comment"
          ? "Turning on comments…"
          : "Turning off comments…";

  useLayoutEffect(() => {
    stopAllOwnerActivity();
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestCopyRequest.current += 1;
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
    setLinkBusy(false);
    setLinkRequestBusy(null);
    setLinkAccess("view");
    setAddAccessByShareId({});
    setLinkError(null);
    setMinted(null);
    setLinkCopied(false);
    setLinks([]);
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
      latestCopyRequest.current += 1;
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
    };
  }, [linkScope]);

  useLayoutEffect(() => {
    if (shareWith !== "link") return;
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
  }, [linkScope, shareWith]);

  useLayoutEffect(() => {
    if (shareWith !== "link") return;
    const nextEligible = new Set(eligibleShareIds);
    const previousEligible = eligibleShareIdsRef.current;
    eligibleShareIdsRef.current = nextEligible;
    for (const shareId of previousEligible) {
      if (!nextEligible.has(shareId)) {
        invalidateDiscussionRequest(shareId);
        expandedOwnerShareIdsRef.current.delete(shareId);
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
  }, [eligibleShareIdsKey, shareWith]);

  async function createShare() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const payload: CreateRelaySharePayload = {
        workspaceId: props.workspaceId,
        recipientEmail: email.trim(),
        access,
        ...(props.target.kind === "version"
          ? { versionId: props.target.versionId }
          : { paths: props.target.paths }),
      };
      const result = await bridge().createRelayShare(payload);
      setCreated({ shareCode: result.shareCode, recipientEmail: result.recipientEmail });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

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
      for (const principal of result.principals) {
        control.principalBlockedById.set(
          principal.principalId,
          principal.blocked,
        );
      }

      updateOwnerDiscussion(control.shareId, (current) => {
        if (!isCurrentOwnerActivity(control) || !current.expanded) {
          return current;
        }
        const messages = applyDiscussionPrincipalOverrides(
          mergeDiscussionMessages(current.messages, result.messages),
          control.principalBlockedById,
        );
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
      updateOwnerDiscussion(shareId, (current) => {
        const mergedMessages =
          cursor === undefined
            ? mergeDiscussionMessages([], result.messages)
            : mergeDiscussionMessages(result.messages, current.messages);
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
      updateOwnerDiscussion(shareId, (current) => ({
        ...current,
        messages: mergeDiscussionMessages(current.messages, [result.message]),
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
      setOwnerMutationError({ shareId, actionKey });
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
    void runOwnerMutation(
      action.shareId,
      `revoke:${action.grantId}`,
      () =>
        bridge().revokeRelayShareGrant({
          workspaceId: props.workspaceId,
          shareId: action.shareId,
          grantId: action.grantId,
        }),
      "inventories",
    );
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
      setLinks(inventory);
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
        !inventory.some(
          (row) =>
            row.status === "active" &&
            row.shareId === current.shareId &&
            row.grantId === current.grantId,
        )
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
      setLinksError(errorMessage(cause));
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
    setLinkCopied(false);

    try {
      const result = await request();
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMintRequest.current !== requestId
      ) {
        return;
      }
      setMinted({ grantId: result.grantId, url: result.url });
      latestCopyRequest.current += 1;
      void refreshLinks(scopeGeneration);
    } catch (cause) {
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMintRequest.current !== requestId
      ) {
        return;
      }
      setLinkError(errorMessage(cause));
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

  async function createLink() {
    const payload: CreateRelayShareLinkPayload =
      props.target.kind === "version"
        ? {
            workspaceId: props.workspaceId,
            versionId: props.target.versionId,
            access: linkAccess,
          }
        : {
            workspaceId: props.workspaceId,
            paths: props.target.paths,
            access: linkAccess,
          };
    await mintLink({ kind: "create" }, () =>
      bridge().createRelayShareLink(payload),
    );
  }

  async function addLink(shareId: string) {
    const access = addAccessByShareId[shareId] ?? "view";
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

  async function mutateLink(action: LinkConfirmation, row: RelayShareLinkRow) {
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
        (action.kind === "retune" && action.access === "comment"));
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

      if (result.outcome === "rotated") {
        latestCopyRequest.current += 1;
        setMinted({ grantId: row.grantId, url: result.url });
        setLinkCopied(false);
      } else if (result.outcome === "widened") {
        latestCopyRequest.current += 1;
        setMinted({ grantId: row.grantId, url: result.url });
        setLinkCopied(false);
        setLinks((current) =>
          current.map((currentRow) =>
            currentRow.shareId === row.shareId && currentRow.grantId === row.grantId
              ? { ...currentRow, access: "comment" }
              : currentRow,
          ),
        );
      } else if (result.outcome === "narrowed") {
        setLinks((current) =>
          current.map((currentRow) =>
            currentRow.shareId === row.shareId && currentRow.grantId === row.grantId
              ? { ...currentRow, access: "view" }
              : currentRow,
          ),
        );
      } else {
        latestCopyRequest.current += 1;
        setMinted((current) =>
          current?.grantId === row.grantId ? null : current,
        );
      }
      setConfirmation(null);
      void refreshLinks(scopeGeneration);
    } catch (cause) {
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestMutationRequest.current !== requestId
      ) {
        return;
      }
      if (retiresDisplayedCredential) {
        latestCopyRequest.current += 1;
        setMinted(null);
        setLinkCopied(false);
      }
      setLifecycleError(errorMessage(cause));
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

  async function copyCode() {
    if (!created) return;
    try {
      await bridge().writeClipboardText({ text: created.shareCode });
      setCopied(true);
    } catch {
      // The code stays visible for manual selection.
    }
  }

  async function copyLink() {
    if (!minted) return;
    const scopeGeneration = linkScopeGeneration.current;
    const requestId = ++latestCopyRequest.current;
    try {
      await bridge().writeClipboardText({ text: minted.url });
      if (
        !isCurrentLinkScope(scopeGeneration) ||
        latestCopyRequest.current !== requestId
      ) {
        return;
      }
      setLinkCopied(true);
    } catch {
      // The link stays visible for manual selection.
    }
  }

  function closeDialog() {
    stopAllOwnerActivity();
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestCopyRequest.current += 1;
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

  return (
    <div
      data-testid="share-dialog"
      className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <Share2 size={14} aria-hidden className="text-subtle" />
        <h2 className="m-0 flex-1 text-sm font-semibold text-ink">Share</h2>
        <IconButton aria-label="Close" onClick={closeDialog}>
          <X size={13} aria-hidden />
        </IconButton>
      </div>

      <p className="m-0 text-xs leading-relaxed text-muted">
        {props.target.kind === "version" ? (
          <>Share {subject}.</>
        ) : (
          <>
            Share <code className="font-mono text-[11px] text-ink">{subject}</code>.
          </>
        )}
      </p>

      <div
        role="radiogroup"
        aria-label="Share with"
        className="flex rounded-lg border border-line bg-panel-2 p-0.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={shareWith === "email"}
          onClick={() => setShareWith("email")}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
            shareWith === "email"
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          Invite by email
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={shareWith === "link"}
          onClick={() => setShareWith("link")}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
            shareWith === "link"
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          Anyone with the link
        </button>
      </div>

      {shareWith === "email" ? (
        <>
          {created === null ? (
            <>
              <div className="flex flex-col gap-1">
                <span className="text-[11px] font-medium text-subtle">Access</span>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Access">
                  {ACCESS_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={access === option.value}
                      data-testid={`share-access-${option.value}`}
                      onClick={() => setAccess(option.value)}
                      className={`flex-1 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                        access === option.value
                          ? "border-ink bg-panel-2 text-ink"
                          : "border-line bg-panel text-muted hover:text-ink"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <p
                  data-testid="share-access-helper"
                  className="m-0 text-[11px] leading-relaxed text-subtle"
                >
                  {ACCESS_OPTIONS.find((option) => option.value === access)?.helper}
                </p>
              </div>

              <p className="m-0 text-xs leading-relaxed text-muted">
                They see what you selected — nothing else — and your later edits arrive
                when they refresh.
              </p>

              <label className="block text-[11px] font-medium text-subtle">
                Share with (email)
                <input
                  data-testid="share-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void createShare();
                  }}
                  placeholder="name@example.com"
                  spellCheck={false}
                  className="mt-1 w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-ink placeholder:text-subtle focus:border-ink"
                />
              </label>
              <PrimaryButton
                type="button"
                data-testid="share-create"
                disabled={!canSubmit}
                onClick={() => void createShare()}
              >
                {busy ? "Creating share…" : "Create share"}
              </PrimaryButton>
            </>
          ) : (
            <>
              <p className="m-0 text-xs leading-relaxed text-muted">
                Send this code to{" "}
                <span className="font-medium text-ink">{created.recipientEmail}</span> —
                they paste it in dohc under “Open a share”.
              </p>
              <div className="flex items-start gap-2">
                <code
                  data-testid="share-code"
                  className="min-w-0 flex-1 break-all rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] leading-snug text-ink"
                >
                  {created.shareCode}
                </code>
                <button
                  type="button"
                  data-testid="share-code-copy"
                  onClick={() => void copyCode()}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  {copied ? (
                    <Check size={12} aria-hidden />
                  ) : (
                    <Copy size={12} aria-hidden />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="m-0 text-[11px] leading-relaxed text-subtle">
                You can end this share anytime from Settings → Cloud.
              </p>
              <button
                type="button"
                data-testid="share-done"
                onClick={closeDialog}
                className="rounded-lg border border-line bg-transparent px-3 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
              >
                Done
              </button>
            </>
          )}

          {error ? (
            <p data-testid="share-error" role="alert" className="m-0 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          {minted ? (
            <div className="flex flex-col gap-2">
              <p className="m-0 text-xs leading-relaxed text-muted">
                Copy the link now — dohc doesn't keep a copy.
              </p>
              <div className="flex items-start gap-2">
                <code
                  data-testid="share-link-url"
                  className="min-w-0 flex-1 select-text break-all rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[11px] leading-snug text-ink"
                >
                  {minted.url}
                </code>
                <button
                  type="button"
                  onClick={() => void copyLink()}
                  className="flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-ink"
                >
                  {linkCopied ? (
                    <Check size={12} aria-hidden />
                  ) : (
                    <Copy size={12} aria-hidden />
                  )}
                  {linkCopied ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="m-0 text-[11px] leading-relaxed text-subtle">
                If you lose the link, reset it to get a new one.
              </p>
              <p className="m-0 text-[11px] leading-relaxed text-subtle">
                To reset or end this link later, open Share on this selection again.
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-medium text-subtle">Access</span>
            <LinkAccessChoice
              access={linkAccess}
              ariaLabel="Link access"
              disabled={
                linkBusy || mutationBusy !== null || confirmation !== null
              }
              onChange={setLinkAccess}
            />
          </div>

          <p className="m-0 text-xs leading-relaxed text-muted">
            Anyone who has the link can read what you selected — no account needed.{" "}
            {props.target.kind === "version"
              ? "The link shows this version as it is now."
              : "If files are added to this selection later, the link includes them."}{" "}
            The sync relay serves the link, so it can read this content.
          </p>
          <p className="m-0 text-xs leading-relaxed text-muted">
            You can end the link at any time. Ending it stops future access, but can't
            take back copies people already made.
          </p>

          {hasMatchingShare ? (
            <p className="m-0 text-[11px] leading-relaxed text-subtle">
              A separate share of this selection, with its own comments.
            </p>
          ) : null}
          <PrimaryButton
            type="button"
            aria-label="Create link"
            disabled={linkBusy || mutationBusy !== null || confirmation !== null}
            onClick={() => void createLink()}
          >
            {linkRequestBusy?.kind === "create"
              ? "Creating link…"
              : hasMatchingShare
                ? "Create separate link"
                : "Create link"}
          </PrimaryButton>

          {linkError ? (
            <p data-testid="share-link-error" role="alert" className="m-0 text-xs text-danger">
              {linkError}
            </p>
          ) : null}

          <section className="flex flex-col gap-2" aria-labelledby="share-links-heading">
            <h3
              id="share-links-heading"
              className="m-0 text-[10px] font-semibold uppercase tracking-wide text-subtle"
            >
              Links
            </h3>

            {linksLoading ? (
              <p className="m-0 text-xs text-muted">Loading links…</p>
            ) : null}

            {linksError ? (
              <div className="flex items-center justify-between gap-3">
                <p role="alert" className="m-0 min-w-0 text-xs text-danger">
                  {linksError}
                </p>
                <SecondaryButton onClick={() => void refreshLinks()}>Retry</SecondaryButton>
              </div>
            ) : null}

            {lifecycleError ? (
              <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
                {lifecycleError}
              </p>
            ) : null}

            {visibleLinkGroups.map((group) => {
              const canAdd = eligibleShareIds.has(group.shareId);
              const addAccess = addAccessByShareId[group.shareId] ?? "view";
              const ownerDiscussion =
                ownerDiscussionByShareId[group.shareId] ?? emptyOwnerDiscussion();
              const ownerDraftInvalid =
                ownerDiscussion.draft.length > 0 &&
                normalizeShareDiscussionBody(ownerDiscussion.draft) === null;
              const showOwnerAppendRetry =
                ownerDiscussion.appendError && !ownerDraftInvalid;
              const ownerDraftErrorId = `share-comment-body-error-${group.shareId}`;
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
              return (
                <div
                  key={group.shareId}
                  data-testid={`share-link-group-${group.shareId}`}
                  className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-2"
                >
                  {group.rows.map((row) => {
                    const damaged = row.selector === null;
                    const active = row.status === "active";
                    const canRetune =
                      !damaged &&
                      (row.access === "view" || row.access === "comment");
                    return (
                      <article
                        key={row.grantId}
                        data-testid={`share-link-row-${row.grantId}`}
                        className="flex flex-col gap-2 border-t border-line pt-2 first:border-t-0 first:pt-0"
                      >
                        {damaged ? (
                          <p className="m-0 text-xs leading-relaxed text-muted">
                            Unreadable link — dohc can't read what this link shares
                          </p>
                        ) : (
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 flex-col gap-1">
                              <p className="m-0 text-[11px] leading-relaxed text-subtle">
                                {row.lastUsedAtMs === null
                                  ? "Not used yet"
                                  : `Used as recently as ${shortTimestamp.format(row.lastUsedAtMs)}`}
                              </p>
                              <p className="m-0 font-mono text-[11px] leading-relaxed text-subtle">
                                {row.status === "revoked"
                                  ? `Created ${shortDate.format(row.createdAtMs)} · Ended ${shortDate.format(row.revokedAtMs ?? row.createdAtMs)}`
                                  : `Created ${shortDate.format(row.createdAtMs)}${
                                      row.urlIssuedAtMs !== null &&
                                      row.urlIssuedAtMs > row.createdAtMs
                                        ? ` · Link reset ${shortDate.format(row.urlIssuedAtMs)}`
                                        : ""
                                    }`}
                              </p>
                            </div>
                            <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-muted">
                              {row.access === "comment" ? "Comment" : "View"}
                            </span>
                          </div>
                        )}

                        {active ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            {canRetune ? (
                              <SecondaryButton
                                disabled={linkBusy || mutationBusy !== null}
                                onClick={() => openConfirmation("retune", row)}
                              >
                                {row.access === "comment"
                                  ? "Turn off comments"
                                  : "Turn on comments"}
                              </SecondaryButton>
                            ) : null}
                            {!damaged ? (
                              <SecondaryButton
                                disabled={linkBusy || mutationBusy !== null}
                                onClick={() => openConfirmation("reset", row)}
                              >
                                Reset link
                              </SecondaryButton>
                            ) : null}
                            <SecondaryButton
                              disabled={linkBusy || mutationBusy !== null}
                              onClick={() => openConfirmation("end", row)}
                            >
                              End link
                            </SecondaryButton>
                          </div>
                        ) : null}
                      </article>
                    );
                  })}

                  {canAdd ? (
                    <section className="flex flex-col gap-2 border-t border-line pt-2">
                      <SecondaryButton
                        aria-expanded={ownerDiscussion.expanded}
                        onClick={() => toggleOwnerDiscussion(group.shareId)}
                      >
                        Comments
                      </SecondaryButton>

                      {ownerDiscussion.expanded ? (
                        <div className="flex flex-col gap-3 rounded-lg bg-panel-2 p-3">
                          <div className="flex flex-col gap-2">
                            <div className="flex justify-end">
                              <SecondaryButton
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
                            {ownerDiscussion.linkCommentsPaused ? (
                              <p className="m-0 text-xs leading-relaxed text-muted">
                                Link comments are paused. People with links can still read
                                everything.
                              </p>
                            ) : null}
                            {ownerMutationError?.shareId === group.shareId &&
                            ownerMutationError.actionKey === "pause" ? (
                              <p role="alert" className="m-0 text-xs text-danger">
                                Couldn't complete that change.
                              </p>
                            ) : null}
                          </div>

                          {ownerDiscussion.loading ? (
                            <p className="m-0 text-xs text-muted">Loading comments…</p>
                          ) : null}

                          {ownerDiscussion.loadError ? (
                            <div className="flex items-center justify-between gap-3">
                              <p role="alert" className="m-0 text-xs text-danger">
                                Couldn't load comments.
                              </p>
                              <SecondaryButton
                                disabled={ownerDiscussion.loading}
                                onClick={() =>
                                  void refreshOwnerDiscussion(
                                    group.shareId,
                                    ownerDiscussion.failedReadCursor ?? undefined,
                                  )
                                }
                              >
                                Retry
                              </SecondaryButton>
                            </div>
                          ) : null}

                          {ownerDiscussion.loaded &&
                          !ownerDiscussion.loading &&
                          ownerDiscussion.messages.length === 0 ? (
                            <p className="m-0 text-xs text-muted">No comments yet.</p>
                          ) : null}

                          {ownerDiscussion.messages.length > 0 ? (
                            <ol className="m-0 flex max-h-64 list-none flex-col gap-2 overflow-y-auto p-0">
                              {ownerDiscussion.messages.map((message) => {
                                const linkAuthored = "moderation" in message;
                                const deleteActionKey = `delete:${message.messageId}`;
                                const principalActionKey = linkAuthored
                                  ? `principal:${message.moderation.linkPrincipalId}`
                                  : null;
                                return (
                                  <li
                                    key={message.messageId}
                                    data-testid={`share-comment-${message.messageId}`}
                                    data-comment-message-id={message.messageId}
                                    className="flex flex-col gap-1 rounded-md border border-line bg-panel p-2"
                                  >
                                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                                      <span className="font-medium text-ink">
                                        {message.author.displayName}
                                      </span>
                                      {message.author.kind === "link" ? (
                                        <span className="text-subtle">Unverified</span>
                                      ) : null}
                                    </div>
                                    <p className="m-0 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
                                      {message.deleted
                                        ? "Comment deleted by the owner"
                                        : message.body}
                                    </p>
                                    <div className="flex flex-wrap justify-end gap-2">
                                      {!message.deleted ? (
                                        <SecondaryButton
                                          disabled={ownerMutationBusy !== null}
                                          onClick={() => {
                                            setOwnerConfirmation({
                                              kind: "delete",
                                              shareId: group.shareId,
                                              messageId: message.messageId,
                                            });
                                          }}
                                        >
                                          Delete comment
                                        </SecondaryButton>
                                      ) : null}
                                      {linkAuthored ? (
                                        message.moderation.blocked ? (
                                          <SecondaryButton
                                            disabled={ownerMutationBusy !== null}
                                            onClick={() =>
                                              void runOwnerMutation(
                                                group.shareId,
                                                principalActionKey!,
                                                () =>
                                                  bridge().unblockRelayShareDiscussionPrincipal(
                                                    {
                                                      workspaceId: props.workspaceId,
                                                      shareId: group.shareId,
                                                      principalId:
                                                        message.moderation
                                                          .linkPrincipalId,
                                                    },
                                                  ),
                                                "discussion",
                                              )
                                            }
                                          >
                                            Unblock
                                          </SecondaryButton>
                                        ) : (
                                          <SecondaryButton
                                            disabled={ownerMutationBusy !== null}
                                            onClick={() => {
                                              setOwnerConfirmation({
                                                kind: "block",
                                                shareId: group.shareId,
                                                principalId:
                                                  message.moderation.linkPrincipalId,
                                                name: message.author.displayName,
                                              });
                                            }}
                                          >
                                            Block
                                          </SecondaryButton>
                                        )
                                      ) : null}
                                    </div>
                                    {ownerMutationError?.shareId === group.shareId &&
                                    (ownerMutationError.actionKey === deleteActionKey ||
                                      ownerMutationError.actionKey ===
                                        principalActionKey) ? (
                                      <p role="alert" className="m-0 text-xs text-danger">
                                        Couldn't complete that change.
                                      </p>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ol>
                          ) : null}

                          {ownerDiscussion.nextCursor !== null ? (
                            <SecondaryButton
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

                          <div className="flex flex-col gap-2 border-t border-line pt-3">
                            <label className="flex flex-col gap-1 text-[11px] font-medium text-subtle">
                              Add a comment
                              <textarea
                                value={ownerDiscussion.draft}
                                disabled={ownerAppendBusy !== null}
                                aria-invalid={ownerDraftInvalid || undefined}
                                aria-describedby={
                                  ownerDraftInvalid ? ownerDraftErrorId : undefined
                                }
                                rows={3}
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
                                className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-2 text-[13px] leading-relaxed text-ink placeholder:text-subtle focus:border-ink disabled:opacity-50"
                              />
                            </label>
                            {ownerDraftInvalid ? (
                              <p
                                id={ownerDraftErrorId}
                                role="alert"
                                className="m-0 text-xs text-danger"
                              >
                                This comment is too long. Shorten it before posting.
                              </p>
                            ) : showOwnerAppendRetry ? (
                              <p role="alert" className="m-0 text-xs text-danger">
                                Couldn't post comment.
                              </p>
                            ) : null}
                            <div className="flex justify-end">
                              <SecondaryButton
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
                                {showOwnerAppendRetry ? "Retry" : "Post"}
                              </SecondaryButton>
                            </div>
                          </div>

                          {group.rows.some(
                            (row) =>
                              row.status === "active" &&
                              row.dependents.some(
                                (dependent) => dependent.recipientUserId !== null,
                              ),
                          ) ? (
                            <div className="flex flex-col gap-2 border-t border-line pt-3">
                              {group.rows.flatMap((row) =>
                                row.status === "active"
                                  ? row.dependents
                                      .filter(
                                        (dependent) =>
                                          dependent.recipientUserId !== null,
                                      )
                                      .map((dependent) => {
                                        const actionKey = `promote:${dependent.grantId}`;
                                        return (
                                          <div
                                            key={`${row.grantId}:${dependent.grantId}`}
                                            data-testid={`share-dependent-${dependent.grantId}`}
                                            className="flex flex-col gap-1"
                                          >
                                            <div className="flex items-center justify-between gap-3">
                                              <span className="min-w-0 break-all text-xs text-muted">
                                                {dependentName(dependent)}
                                              </span>
                                              <SecondaryButton
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
                                            {ownerMutationError?.shareId ===
                                              group.shareId &&
                                            ownerMutationError.actionKey === actionKey ? (
                                              <p
                                                role="alert"
                                                className="m-0 text-xs text-danger"
                                              >
                                                Couldn't complete that change.
                                              </p>
                                            ) : null}
                                          </div>
                                        );
                                      })
                                  : [],
                              )}
                            </div>
                          ) : null}

                          {shareIndependentGrants.length > 0 ? (
                            <div className="flex flex-col gap-2 border-t border-line pt-3">
                              {shareIndependentGrants.map((grant) => {
                                const actionKey = `revoke:${grant.grantId}`;
                                return (
                                  <div
                                    key={grant.grantId}
                                    data-testid={`share-independent-${grant.grantId}`}
                                    className="flex flex-col gap-1"
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <span className="min-w-0 break-all text-xs text-muted">
                                        {namedGrantName(grant)}
                                      </span>
                                      <SecondaryButton
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
                                      <p role="alert" className="m-0 text-xs text-danger">
                                        Couldn't complete that change.
                                      </p>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}

                          {ownerConfirmation?.shareId === group.shareId ? (
                            <div
                              data-testid="owner-comments-confirmation"
                              className="flex flex-col gap-2 rounded-lg border border-line bg-panel p-3"
                            >
                              <p className="m-0 text-xs leading-relaxed text-ink">
                                {ownerConfirmation.kind === "delete"
                                  ? "Delete this comment? Its text is removed for everyone right away and can't be brought back. Readers see that a comment was deleted."
                                  : ownerConfirmation.kind === "block"
                                    ? `Block ${ownerConfirmation.name}? They can't comment through this link from this browser until you unblock them. They can still comment from another browser or another link. To stop everyone with this link, reset it.`
                                    : ownerConfirmation.kind === "promote"
                                      ? `Make ${ownerConfirmation.name}'s access independent of this link? This is permanent. Resetting or ending the link no longer affects their access. You can end their access here at any time.`
                                      : `End ${ownerConfirmation.name}'s access? They lose access right away. Copies they already made stay with them.`}
                              </p>
                              <div className="flex justify-end gap-2">
                                <SecondaryButton
                                  disabled={ownerMutationBusy !== null}
                                  onClick={() => setOwnerConfirmation(null)}
                                >
                                  Cancel
                                </SecondaryButton>
                                <SecondaryButton
                                  disabled={ownerMutationBusy !== null}
                                  aria-busy={ownerMutationBusy !== null}
                                  onClick={() =>
                                    executeOwnerConfirmation(ownerConfirmation)
                                  }
                                >
                                  {ownerConfirmation.kind === "delete"
                                    ? "Delete comment"
                                    : ownerConfirmation.kind === "block"
                                      ? "Block"
                                      : ownerConfirmation.kind === "promote"
                                        ? "Make independent"
                                        : "End access"}
                                </SecondaryButton>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </section>
                  ) : null}

                  {canAdd ? (
                    <div className="flex flex-col gap-2 border-t border-line pt-2">
                      <p className="m-0 text-[11px] leading-relaxed text-subtle">
                        Another link to the same share. Same files, same comments.
                      </p>
                      <LinkAccessChoice
                        access={addAccess}
                        ariaLabel="Access for another link"
                        disabled={
                          linkBusy ||
                          mutationBusy !== null ||
                          confirmation !== null
                        }
                        onChange={(nextAccess) =>
                          setAddAccessByShareId((current) => ({
                            ...current,
                            [group.shareId]: nextAccess,
                          }))
                        }
                      />
                      <SecondaryButton
                        disabled={
                          linkBusy ||
                          mutationBusy !== null ||
                          confirmation !== null
                        }
                        onClick={() => void addLink(group.shareId)}
                      >
                        {linkRequestBusy?.kind === "add" &&
                        linkRequestBusy.shareId === group.shareId
                          ? "Adding link…"
                          : "Add link"}
                      </SecondaryButton>
                    </div>
                  ) : null}
                </div>
              );
            })}

            {confirmation && confirmationRow ? (
              <div
                data-testid="share-link-confirmation"
                className="flex flex-col gap-2 rounded-lg border border-line bg-panel-2 p-3"
              >
                <p className="m-0 text-xs leading-relaxed text-ink">
                  {confirmation.kind === "retune" ? (
                    confirmation.access === "comment" ? (
                      <>
                        Turn on comments for this link? The current link stops working
                        right away, and dohc shows the new link once.
                        {confirmationRow.dependents.length > 0 ? (
                          <>
                            {" "}People who joined through it keep access and stay at
                            their current level:{" "}
                            <DependentNames dependents={confirmationRow.dependents} />.
                          </>
                        ) : null}
                      </>
                    ) : (
                      <>
                        Turn off comments for this link? The same link keeps working, for
                        viewing only.
                        {narrowerDependents.length > 0 ? (
                          <>
                            {" "}These people drop to view too:{" "}
                            <DependentNames dependents={narrowerDependents} />.
                          </>
                        ) : null}
                      </>
                    )
                  ) : confirmation.kind === "reset" ? (
                    <>
                      Reset this link? The current link stops working right away, and dohc
                      shows the new link once.
                      {confirmationRow.dependents.length > 0 ? (
                        <>
                          {" "}People who joined through it keep access:{" "}
                          <DependentNames dependents={confirmationRow.dependents} />. To
                          remove them, end the link instead.
                        </>
                      ) : null}
                    </>
                  ) : confirmationRow.dependents.length === 0 ? (
                    <>
                      End this link? It stops working right away. Copies people already made
                      stay with them.
                    </>
                  ) : (
                    <>
                      End this link? It stops working right away, and these people lose
                      access through it: <DependentNames dependents={confirmationRow.dependents} />.
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
                  <PrimaryButton
                    disabled={mutationBusy !== null}
                    onClick={() => void mutateLink(confirmation, confirmationRow)}
                  >
                    {mutationBusy?.grantId === confirmationRow.grantId
                      ? confirmationPendingLabel
                      : confirmationActionLabel}
                  </PrimaryButton>
                </div>
              </div>
            ) : null}
          </section>
        </>
      )}
    </div>
  );
}
