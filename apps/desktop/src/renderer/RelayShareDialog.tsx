import { Check, Copy, Share2, X } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CreateRelayShareLinkPayload,
  CreateRelaySharePayload,
  RelayShareLinkDependent,
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
    value: "comment",
    label: "Comment",
    helper: "They can read what you selected and chat about it.",
  },
  {
    value: "edit",
    label: "Edit",
    helper: "They can read, chat, and send you changes to accept.",
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
  const linkScopeGeneration = useRef(0);
  const latestMintRequest = useRef(0);
  const latestCopyRequest = useRef(0);
  const latestInventoryRequest = useRef(0);
  const latestMutationRequest = useRef(0);

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
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestCopyRequest.current += 1;
    latestInventoryRequest.current += 1;
    latestMutationRequest.current += 1;
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

    return () => {
      linkScopeGeneration.current += 1;
      latestMintRequest.current += 1;
      latestCopyRequest.current += 1;
      latestInventoryRequest.current += 1;
      latestMutationRequest.current += 1;
    };
  }, [linkScope]);

  useLayoutEffect(() => {
    if (shareWith !== "link") return;
    const scopeGeneration = linkScopeGeneration.current;
    void refreshLinks(scopeGeneration);
    return () => {
      latestInventoryRequest.current += 1;
    };
  }, [linkScope, shareWith]);

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

  async function refreshLinks(scopeGeneration = linkScopeGeneration.current) {
    if (!isCurrentLinkScope(scopeGeneration)) return;
    const requestId = ++latestInventoryRequest.current;
    setLinksLoading(true);
    setLinksError(null);
    try {
      const inventory: RelayShareLinkRow[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      while (true) {
        if (
          !isCurrentLinkScope(scopeGeneration) ||
          latestInventoryRequest.current !== requestId
        ) {
          return;
        }
        const result = await bridge().listRelayShareLinks({
          workspaceId: props.workspaceId,
          ...(cursor ? { cursor } : {}),
        });
        if (
          !isCurrentLinkScope(scopeGeneration) ||
          latestInventoryRequest.current !== requestId
        ) {
          return;
        }
        inventory.push(...result.links);
        if (result.nextCursor === undefined) break;
        if (seenCursors.has(result.nextCursor)) {
          throw new Error("dohc could not load all links.");
        }
        seenCursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      setLinks(inventory);
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
      setLifecycleError(errorMessage(cause));
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
    linkScopeGeneration.current += 1;
    latestMintRequest.current += 1;
    latestCopyRequest.current += 1;
    latestInventoryRequest.current += 1;
    latestMutationRequest.current += 1;
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
              const canAdd = group.rows.some((row) =>
                rowMatchesTarget(row, props.target),
              );
              const addAccess = addAccessByShareId[group.shareId] ?? "view";
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
