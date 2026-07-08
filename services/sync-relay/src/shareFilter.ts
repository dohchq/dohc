import { classifyEngineFilePath } from "@dohc/workspace-engine/enginePathFloor";
import { validateUserWritePath } from "@dohc/workspace-core";

// PR 18 share grants: the server-side filter that decides which replicated
// ops (and which blobs) a share RECIPIENT may see. This module is the
// security boundary for external shares — everything here fails closed.
//
// Design note (recorded in the execution log): shares are LIVE-FOLLOW
// read-only views. The recipient re-uses the relay's since-cursor log fetch
// with this filter applied server-side, so a granter's later edits to shared
// paths reach the recipient on refresh, and nothing outside the selector
// ever crosses the wire. A point-in-time snapshot was the alternative; the
// live-follow choice reuses the whole sync pipeline (cursoring, blobs,
// idempotent re-fetch) instead of inventing a parallel snapshot format.
//
// The relay normally treats op payloads as opaque. Shares deliberately relax
// that in ONE direction: the filter may READ well-known path/hash/version
// fields to decide inclusion, and may REDACT one field (version.create's
// forkSnapshots). It still never interprets content, and any op kind or
// payload shape it does not positively recognize is EXCLUDED.

export const MAX_SHARE_PATHS = 100;
export const MAX_SHARE_PATH_CHARS = 1024;
export const MAX_SHARE_VERSION_ID_CHARS = 128;
export const MAX_CHANNEL_WIRE_ID_CHARS = 256;

export const MAIN_VERSION_ID = "main";

export interface ShareSelector {
  // Normalized workspace-relative paths. A path selects itself and, as a
  // prefix, everything beneath it ("docs" selects "docs/a.md"). Empty means
  // "every tracked path" and is only valid for version shares.
  paths: string[];
  // null = live-follow of the main version; otherwise the shared version id.
  versionId: string | null;
}

// MU-C4 shared channels: a BIDIRECTIONAL chat-channel grant. Unlike the
// read-only path/version selector above, a chat-channel share scopes a whole
// channel (its channel/thread/message/reaction ops, nothing else) and — when
// access is "read-write" — lets the member APPEND channel-scoped chat ops via
// the member append route. "read-only" is the broadcast/announcements opt-in:
// the member replays the channel but every inbound append is refused.
export const CHAT_SHARE_ACCESS_VALUES = ["read-write", "read-only"] as const;
export type ChatShareAccess = (typeof CHAT_SHARE_ACCESS_VALUES)[number];

export interface ChatChannelShareSelector {
  kind: "chat-channel";
  // The channel's cross-machine wire identity (chat_channel_wire_ids in the
  // engine; `wireId` on chat.channel.create). NEVER a local channel id or
  // slug — those differ per machine.
  channelWireId: string;
  access: ChatShareAccess;
}

export type AnyShareSelector = ShareSelector | ChatChannelShareSelector;

export function isChatChannelSelector(
  selector: AnyShareSelector,
): selector is ChatChannelShareSelector {
  return "kind" in selector && (selector as { kind?: unknown }).kind === "chat-channel";
}

export type ChatChannelSelectorValidation =
  | { ok: true; selector: ChatChannelShareSelector }
  | { ok: false; code: "invalid_channel" | "invalid_access"; message: string };

export function validateChatChannelShareSelector(input: {
  channelWireId?: unknown;
  access?: unknown;
}): ChatChannelSelectorValidation {
  const wireId = input.channelWireId;
  if (
    typeof wireId !== "string" ||
    wireId.length === 0 ||
    wireId.trim() !== wireId ||
    wireId.length > MAX_CHANNEL_WIRE_ID_CHARS
  ) {
    return {
      ok: false,
      code: "invalid_channel",
      message: "channelWireId must be a non-empty trimmed string",
    };
  }
  // Default read-write (the design's accepted recommendation): a shared
  // channel is collaborative by nature; read-only is the explicit broadcast
  // opt-in.
  const access = input.access ?? "read-write";
  if (access !== "read-write" && access !== "read-only") {
    return {
      ok: false,
      code: "invalid_access",
      message: 'access must be "read-write" or "read-only"',
    };
  }
  return { ok: true, selector: { kind: "chat-channel", channelWireId: wireId, access } };
}

export type ShareSelectorValidation =
  | { ok: true; selector: ShareSelector }
  | {
      ok: false;
      code:
        | "empty_selector"
        | "too_many_paths"
        | "invalid_path"
        | "secret_path"
        | "invalid_version";
      message: string;
    };

// Grant-time gate #1 for secrets: selector paths must classify as engine
// "tracked" — secret-classified paths (the .env family, however encoded) are
// refused OUTRIGHT at grant time, and traversal/absolute/reserved paths are
// refused by the same classifier's underlying validation. Gate #2 is the
// per-op defensive filter below; both are tested independently.
export function validateShareSelector(input: {
  paths?: unknown;
  versionId?: unknown;
}): ShareSelectorValidation {
  const rawPaths = input.paths ?? [];
  if (!Array.isArray(rawPaths)) {
    return { ok: false, code: "invalid_path", message: "paths must be an array" };
  }
  if (rawPaths.length > MAX_SHARE_PATHS) {
    return {
      ok: false,
      code: "too_many_paths",
      message: `a share can select at most ${MAX_SHARE_PATHS} paths`,
    };
  }
  const paths: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SHARE_PATH_CHARS) {
      return { ok: false, code: "invalid_path", message: "each path must be a non-empty string" };
    }
    const validated = validateUserWritePath(raw);
    if (!validated.ok) {
      return {
        ok: false,
        code: "invalid_path",
        message: "a selected path is not a valid workspace path",
      };
    }
    const classification = classifyEngineFilePath(validated.normalized);
    if (classification.kind === "secret") {
      return {
        ok: false,
        code: "secret_path",
        message: "secret files cannot be shared",
      };
    }
    if (classification.kind !== "tracked") {
      return {
        ok: false,
        code: "invalid_path",
        message: "a selected path is not shareable",
      };
    }
    paths.push(validated.normalized);
  }
  let versionId: string | null = null;
  if (input.versionId !== undefined && input.versionId !== null) {
    if (
      typeof input.versionId !== "string" ||
      input.versionId.trim() !== input.versionId ||
      input.versionId.length === 0 ||
      input.versionId.length > MAX_SHARE_VERSION_ID_CHARS
    ) {
      return { ok: false, code: "invalid_version", message: "versionId is not valid" };
    }
    versionId = input.versionId;
  }
  if (paths.length === 0 && versionId === null) {
    return {
      ok: false,
      code: "empty_selector",
      message: "a share must select at least one path or a version",
    };
  }
  const deduped = [...new Set(paths)].sort();
  return { ok: true, selector: { paths: deduped, versionId } };
}

export function parseShareSelectorJson(selectorJson: string): ShareSelector | null {
  try {
    const parsed = JSON.parse(selectorJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as { paths?: unknown; versionId?: unknown };
    if (!Array.isArray(candidate.paths)) return null;
    if (!candidate.paths.every((path) => typeof path === "string" && path.length > 0)) return null;
    if (candidate.versionId !== null && typeof candidate.versionId !== "string") return null;
    return { paths: candidate.paths as string[], versionId: candidate.versionId as string | null };
  } catch {
    return null;
  }
}

// Union parser for stored selector rows. A `kind: "chat-channel"` row is
// re-validated on every load (a hand-edited/corrupt row fails closed to null,
// which the routes answer with the generic 404); everything else parses as
// the legacy path/version selector.
export function parseAnyShareSelectorJson(selectorJson: string): AnyShareSelector | null {
  try {
    const parsed = JSON.parse(selectorJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if ((parsed as { kind?: unknown }).kind === "chat-channel") {
      const validation = validateChatChannelShareSelector(
        parsed as { channelWireId?: unknown; access?: unknown },
      );
      return validation.ok ? validation.selector : null;
    }
  } catch {
    return null;
  }
  return parseShareSelectorJson(selectorJson);
}

// Gate #2 for secrets (and gate #1 for everything else): a path is visible
// through a share only when it is BOTH inside the selector and classified
// engine-tracked right now. Even a selector that somehow contained a secret
// path (bug, hand-edited row) cannot leak secret ops through this check.
function pathVisibleThroughShare(selector: ShareSelector, path: string): boolean {
  const validated = validateUserWritePath(path);
  if (!validated.ok) return false;
  if (classifyEngineFilePath(validated.normalized).kind !== "tracked") return false;
  if (selector.paths.length === 0) return selector.versionId !== null;
  return selector.paths.some(
    (selected) =>
      validated.normalized === selected || validated.normalized.startsWith(`${selected}/`),
  );
}

function targetVersionId(selector: ShareSelector): string {
  return selector.versionId ?? MAIN_VERSION_ID;
}

// MU-C1 presence gate: whether a share RECIPIENT may join the ephemeral
// awareness scope for `topic`. Fail-closed and reuses the SAME visibility
// check the durable filter uses, so presence can never fan out to a scope the
// share does not already expose. Today a topic is a workspace-relative path
// (doc co-presence on a shared file); a future chat-channel selector (MU-C4)
// extends this to allow `topic === selector.channelWireId`. Everything the
// share does not positively expose is refused — a recipient of `a.md` cannot
// subscribe to presence for `b.md`.
export function presenceTopicAllowedForShare(
  selector: ShareSelector,
  topic: string,
): boolean {
  if (typeof topic !== "string" || topic.length === 0) return false;
  return pathVisibleThroughShare(selector, topic);
}

export type ShareOpDecision =
  | { allowed: false }
  | {
      allowed: true;
      // The payload to serve — identical to the stored payload except for
      // version.create, whose forkSnapshots are redacted to the selector.
      payload: unknown;
      // Every blob hash this op legitimately exposes to the recipient.
      blobSha256s: string[];
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function collectString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// Rebuilds the SERVED payload from an explicit per-kind allowlist (the same
// posture as the moment.append/version.create branches): a stored payload
// that grows an internal-only field (audit metadata, device ids, ...) must
// never cross the share boundary un-redacted. Absent optional fields stay
// absent.
function pickServed(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const served: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) served[key] = record[key];
  }
  return served;
}

// MU-C4: how the chat branch resolves a message/reaction op's channel. The
// ops themselves carry only a threadId; the thread→channel binding lives in
// the owner's OWN log, in the chat.thread.create op for that thread. The
// EARLIEST such op (relay order) is authoritative — it mirrors the engine's
// insert-if-absent apply, so a later forged re-create of an existing thread
// can never re-bind it into (or out of) a shared channel.
export interface ChatShareThreadResolver {
  // The channelWireId claimed by the EARLIEST chat.thread.create op for this
  // threadId in the shared workspace's log, or null when the log holds no
  // binding (unknown thread, or a file-linked thread with no channel).
  threadChannelWireId(threadId: string): string | null;
}

// The chat branch of the fail-closed share filter (MU-C4). Strict allowlist,
// scoped to EXACTLY the granted channel's wire id:
//   - chat.channel.create for the granted wireId (the join bootstrap);
//   - chat.thread.create carrying the granted channelWireId, provided the
//     log's earliest binding for that threadId (if any) is ALSO the granted
//     channel — a forged re-bind of a foreign thread is excluded;
//   - chat.message.append / chat.reaction.set whose thread resolves (earliest
//     binding) to the granted channel.
// Everything else — another channel's ops, file moments, secret ops, DMs,
// version ops, workspace.init, unknown kinds — falls through to the caller's
// terminal deny. Chat ops are blob-free, so the branch never exposes a blob.
function filterChatOpForChannelShare(
  selector: ChatChannelShareSelector,
  opKind: string,
  payload: unknown,
  chat: ChatShareThreadResolver | undefined,
): ShareOpDecision {
  // No resolver wired = no way to scope by channel = nothing is served.
  if (!chat) return { allowed: false };
  const record = asRecord(payload);
  if (!record) return { allowed: false };

  if (opKind === "chat.channel.create") {
    if (collectString(record.wireId) !== selector.channelWireId) return { allowed: false };
    return {
      allowed: true,
      payload: pickServed(record, ["channelId", "name", "slug", "kind", "createdAtMs", "wireId"]),
      blobSha256s: [],
    };
  }

  if (opKind === "chat.thread.create") {
    if (collectString(record.channelWireId) !== selector.channelWireId) {
      return { allowed: false };
    }
    // A channel thread never carries a linked-file owner; an op claiming both
    // is malformed (the engine would refuse it) and is excluded outright.
    if (record.linkedObjectId !== undefined) return { allowed: false };
    const threadId = collectString(record.threadId);
    if (!threadId) return { allowed: false };
    const bound = chat.threadChannelWireId(threadId);
    // null = this op IS the first binding (member append path, not yet in the
    // log). A non-null binding must be the granted channel — otherwise this
    // op is a forged re-bind of an existing foreign thread.
    if (bound !== null && bound !== selector.channelWireId) return { allowed: false };
    // linkedObjectId/linkedPathHint/linkedAtMs are deliberately NOT served: a
    // channel thread never carries a linked-file owner (enforced above).
    return {
      allowed: true,
      payload: pickServed(record, ["threadId", "title", "createdAtMs", "channelSlug", "channelWireId"]),
      blobSha256s: [],
    };
  }

  if (opKind === "chat.message.append" || opKind === "chat.reaction.set") {
    const threadId = collectString(record.threadId);
    if (!threadId) return { allowed: false };
    if (chat.threadChannelWireId(threadId) !== selector.channelWireId) {
      return { allowed: false };
    }
    return {
      allowed: true,
      payload:
        opKind === "chat.message.append"
          ? pickServed(record, [
              "messageId",
              "threadId",
              "authorKind",
              "authorDisplayName",
              "authorUserId",
              "body",
              "createdAtMs",
            ])
          : pickServed(record, [
              "reactionId",
              "messageId",
              "threadId",
              "emoji",
              "authorId",
              "authorKind",
              "authorDisplayName",
              "state",
              "atMs",
            ]),
      blobSha256s: [],
    };
  }

  return { allowed: false };
}

// The single decision point for what a share recipient may read. Strict
// allowlist per selector kind. Path/version selector: moment.append (all
// referenced paths visible, version matches), version.create for the shared
// version (forkSnapshots redacted), and the payload-free workspace.init
// bootstrap op — chats stay excluded. Chat-channel selector (MU-C4): ONLY the
// granted channel's chat ops (see filterChatOpForChannelShare) — file, secret,
// version, and bootstrap ops stay excluded. EVERYTHING unrecognized is
// excluded either way.
export function filterOpForShare(
  selector: AnyShareSelector,
  opKind: string,
  payloadJson: string,
  chat?: ChatShareThreadResolver,
): ShareOpDecision {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return { allowed: false };
  }

  if (isChatChannelSelector(selector)) {
    return filterChatOpForChannelShare(selector, opKind, payload, chat);
  }

  if (opKind === "workspace.init") {
    // Bootstrap op with an empty payload: creates the workspace + main
    // version on the recipient's replica. Nothing to leak, nothing to redact.
    return { allowed: true, payload: {}, blobSha256s: [] };
  }

  if (opKind === "moment.append") {
    const record = asRecord(payload);
    if (!record) return { allowed: false };
    if (record.versionId !== targetVersionId(selector)) return { allowed: false };
    const paths = [
      collectString(record.path),
      collectString(record.payloadBeforePath),
      collectString(record.payloadAfterPath),
      collectString(record.beforePath),
    ].filter((path): path is string => path !== null);
    if (paths.length === 0) return { allowed: false };
    // ALL referenced paths must be visible — a rename that crosses the share
    // boundary (either direction) is excluded rather than leaking the
    // outside path. Known limitation: such a file goes stale in the shared
    // view until its next in-boundary write.
    if (!paths.every((path) => pathVisibleThroughShare(selector, path))) {
      return { allowed: false };
    }
    // Build a MINIMAL served payload from the allowlist of fields the
    // recipient's replay actually needs (workspace-engine syncShareView).
    // Everything else in the stored moment — author, metadata.summary,
    // metadata.correlationId, moment/object ids, lineage (before* fields),
    // and raw recorded timestamps — is dropped so nothing beyond the
    // in-selector change description crosses the share boundary. The author
    // is replaced with a neutral sync origin.
    const afterSha = collectString(record.payloadAfterBlobSha256);
    const served: Record<string, unknown> = {
      operation: typeof record.operation === "string" ? record.operation : null,
      metadata: { origin: "sync" },
    };
    const inPath = collectString(record.path);
    if (inPath) served.path = inPath;
    const afterPath = collectString(record.payloadAfterPath);
    if (afterPath) served.payloadAfterPath = afterPath;
    const beforePath = collectString(record.payloadBeforePath);
    if (beforePath) served.payloadBeforePath = beforePath;
    if (afterSha) served.payloadAfterBlobSha256 = afterSha;
    if (record.payloadAfterContentKind === "binary") {
      served.payloadAfterContentKind = "binary";
    }
    // Only the after-blob is ever fetched by the recipient (before-blobs are
    // never replayed), so it is the only hash we make reachable.
    const blobSha256s = afterSha ? [afterSha] : [];
    return { allowed: true, payload: served, blobSha256s };
  }

  if (opKind === "version.create") {
    if (selector.versionId === null) return { allowed: false };
    const record = asRecord(payload);
    if (!record) return { allowed: false };
    if (record.versionId !== selector.versionId) return { allowed: false };
    // forkSnapshots carry one row per file of the SOURCE version at fork
    // time — including files far outside the share. Redact to the selector;
    // rows whose shape is not understood are dropped, never passed through.
    // Each kept row is rebuilt to the MINIMAL replay shape (path, blob sha,
    // content kind) so snapshot metadata and lineage (objectId,
    // latestMomentId, updatedAtMs, metadata) never leak, and the version
    // payload itself is reduced to its id + the redacted snapshots.
    const rawSnapshots = Array.isArray(record.forkSnapshots) ? record.forkSnapshots : [];
    const keptSnapshots: Array<Record<string, unknown>> = [];
    const blobSha256s: string[] = [];
    for (const raw of rawSnapshots) {
      const snapshot = asRecord(raw);
      if (!snapshot) continue;
      const path = collectString(snapshot.path);
      if (!path || !pathVisibleThroughShare(selector, path)) continue;
      const minimal: Record<string, unknown> = { path };
      const sha = collectString(snapshot.blobSha256);
      if (sha) {
        minimal.blobSha256 = sha;
        blobSha256s.push(sha);
      }
      if (snapshot.contentKind === "binary") minimal.contentKind = "binary";
      keptSnapshots.push(minimal);
    }
    return {
      allowed: true,
      payload: { versionId: selector.versionId, forkSnapshots: keptSnapshots },
      blobSha256s,
    };
  }

  return { allowed: false };
}
