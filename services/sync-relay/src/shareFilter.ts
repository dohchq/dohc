import { classifyEngineFilePath } from "@dohc/security-contract/engine-path-floor";
import {
  MAX_SHARE_VERSION_ID_CHARS,
  type ShareAccess,
  isShareAccessValue,
  isValidShareVersionId,
} from "@dohc/security-contract/share-selector";
import { validateUserWritePath } from "@dohc/workspace-core";
import { RELAY_ERRORS } from "./errorCodes";

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
export const MAX_CHANNEL_WIRE_ID_CHARS = 256;

export const MAIN_VERSION_ID = "main";

export interface ShareSelector {
  // Normalized workspace-relative paths. A path selects itself and, as a
  // prefix, everything beneath it ("docs" selects "docs/a.md"). Empty means
  // "every tracked path" and is only valid for version shares.
  paths: string[];
  // null = live-follow of the main version; otherwise the shared version id.
  versionId: string | null;
  // The level the recipient holds on this selector (#646). Required: a
  // selector without one is not a legacy grant, it is unreadable. All three
  // levels grant the same reads today; PR2 opens comment and edit to chat,
  // PR3 opens edit to document writes.
  access: ShareAccess;
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

export type ChatShareChannelKind = "channel" | "dm" | "agent";

// MU-C4: how the chat branch resolves channel and thread ownership from the
// workspace owner's append-only log. Both lookups use the EARLIEST matching
// create op, mirroring the engine's insert-if-absent apply semantics: a later
// forged create can never change a channel's kind or re-bind a thread.
export interface ChatShareThreadResolver {
  // The kind claimed by the EARLIEST chat.channel.create op for this wire id,
  // undefined when no create exists yet, or null when an authoritative create
  // exists but is malformed/unshareable.
  channelKind(channelWireId: string): ChatShareChannelKind | null | undefined;
  // The channelWireId claimed by the EARLIEST chat.thread.create op for this
  // threadId. undefined means no create exists yet; null means an authoritative
  // create exists but has no shareable channel binding (for example, a
  // file-linked thread). Keeping those states distinct prevents a later batch
  // from treating a private thread as new and re-binding it into a share.
  threadChannelWireId(threadId: string): string | null | undefined;
}

export function isChatChannelSelector(
  selector: AnyShareSelector,
): selector is ChatChannelShareSelector {
  return "kind" in selector && (selector as { kind?: unknown }).kind === "chat-channel";
}

export type ChatChannelSelectorValidation =
  | { ok: true; selector: ChatChannelShareSelector }
  | {
      ok: false;
      code:
        | typeof RELAY_ERRORS.invalid_channel.code
        | typeof RELAY_ERRORS.invalid_access.code;
      message: string;
    };

export function validateChatChannelShareSelector(
  input: {
    channelWireId?: unknown;
    access?: unknown;
  },
  chat?: Pick<ChatShareThreadResolver, "channelKind">,
): ChatChannelSelectorValidation {
  const wireId = input.channelWireId;
  if (
    typeof wireId !== "string" ||
    wireId.length === 0 ||
    wireId.trim() !== wireId ||
    wireId.length > MAX_CHANNEL_WIRE_ID_CHARS
  ) {
    return {
      ok: false,
      code: RELAY_ERRORS.invalid_channel.code,
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
      code: RELAY_ERRORS.invalid_access.code,
      message: 'access must be "read-write" or "read-only"',
    };
  }
  // The request carries only a wire id; channel kind is trusted exclusively
  // from the owner's log. Unknown/pre-provisioned wires remain grantable for
  // the existing create-before-sync flow, but a positively identified agent
  // channel is never eligible for the per-recipient share lane.
  const resolvedKind = chat?.channelKind(wireId);
  if (resolvedKind === "agent") {
    return {
      ok: false,
      code: RELAY_ERRORS.invalid_channel.code,
      message: "agent channels cannot be shared",
    };
  }
  if (resolvedKind === null) {
    return {
      ok: false,
      code: RELAY_ERRORS.invalid_channel.code,
      message: "channel is not shareable",
    };
  }
  return { ok: true, selector: { kind: "chat-channel", channelWireId: wireId, access } };
}

export type ShareSelectorValidation =
  | { ok: true; selector: ShareSelector }
  | {
      ok: false;
      code:
        | typeof RELAY_ERRORS.empty_selector.code
        | typeof RELAY_ERRORS.too_many_paths.code
        | typeof RELAY_ERRORS.invalid_path.code
        | typeof RELAY_ERRORS.secret_path.code
        | typeof RELAY_ERRORS.invalid_version.code
        | typeof RELAY_ERRORS.invalid_access.code;
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
  access?: unknown;
}): ShareSelectorValidation {
  const access = input.access;
  if (!isShareAccessValue(access)) {
    return {
      ok: false,
      code: RELAY_ERRORS.invalid_access.code,
      message: 'access must be "view", "comment", or "edit"',
    };
  }
  // FIRST, before paths or version. A share is minted here and the level is
  // required (#646, decision G at the minting boundary): a caller that names
  // no level has not chosen `view`, it has failed to say what it grants. It
  // is checked first so that answer is the SAME whatever else is wrong —
  // otherwise a bad path decided which of two refusals a caller saw.
  const rawPaths = input.paths ?? [];
  if (!Array.isArray(rawPaths)) {
    return {
      ok: false,
      code: RELAY_ERRORS.invalid_path.code,
      message: "paths must be an array",
    };
  }
  if (rawPaths.length > MAX_SHARE_PATHS) {
    return {
      ok: false,
      code: RELAY_ERRORS.too_many_paths.code,
      message: `a share can select at most ${MAX_SHARE_PATHS} paths`,
    };
  }
  const paths: string[] = [];
  for (const raw of rawPaths) {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_SHARE_PATH_CHARS) {
      return {
        ok: false,
        code: RELAY_ERRORS.invalid_path.code,
        message: "each path must be a non-empty string",
      };
    }
    const validated = validateUserWritePath(raw);
    if (!validated.ok) {
      return {
        ok: false,
        code: RELAY_ERRORS.invalid_path.code,
        message: "a selected path is not a valid workspace path",
      };
    }
    const classification = classifyEngineFilePath(validated.normalized);
    if (classification.kind === "secret") {
      return {
        ok: false,
        code: RELAY_ERRORS.secret_path.code,
        message: "secret files cannot be shared",
      };
    }
    if (classification.kind !== "tracked") {
      return {
        ok: false,
        code: RELAY_ERRORS.invalid_path.code,
        message: "a selected path is not shareable",
      };
    }
    paths.push(validated.normalized);
  }
  let versionId: string | null = null;
  if (input.versionId !== undefined && input.versionId !== null) {
    // One rule, one place: `isValidShareVersionId` is the same check every
    // recipient surface re-applies when it reads a selector back.
    if (!isValidShareVersionId(input.versionId)) {
      return {
        ok: false,
        code: RELAY_ERRORS.invalid_version.code,
        // The unit is UTF-16 code units, because that is what the rule
        // measures (`String.length`). Saying "characters" misreports an
        // astral id by half, and the recipient's twin refusal
        // (`crates/dohc-engine-sync/src/error.rs`,
        // `SyncError::ShareVersionUnusable`) names the same unit — and the
        // observed length with it, so 129 and 10,000 do not read alike.
        message: `versionId must be a non-empty trimmed string of at most ${MAX_SHARE_VERSION_ID_CHARS} UTF-16 code units${
          typeof input.versionId === "string"
            ? `; this one is ${input.versionId.length}`
            : ""
        }`,
      };
    }
    versionId = input.versionId;
  }
  if (paths.length === 0 && versionId === null) {
    return {
      ok: false,
      code: RELAY_ERRORS.empty_selector.code,
      message: "a share must select at least one path or a version",
    };
  }
  const deduped = [...new Set(paths)].sort();
  return { ok: true, selector: { paths: deduped, versionId, access } };
}

// A persisted row must carry an EXPLICIT, valid access, the same rule create
// applies. A row missing the field, or carrying a value the relay never
// issues, fails closed to null and the routes answer that with the generic
// 404 — decision G, stated plainly: no migration shim, no implicit upgrade,
// and no level invented for a row that never named one.
export function parseShareSelectorJson(selectorJson: string): ShareSelector | null {
  try {
    const parsed = JSON.parse(selectorJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const candidate = parsed as { paths?: unknown; versionId?: unknown; access?: unknown };
    if (!Array.isArray(candidate.paths)) return null;
    if (!candidate.paths.every((path) => typeof path === "string" && path.length > 0)) return null;
    if (candidate.versionId !== null && typeof candidate.versionId !== "string") return null;
    if (!isShareAccessValue(candidate.access)) return null;
    return {
      paths: candidate.paths as string[],
      versionId: candidate.versionId as string | null,
      access: candidate.access,
    };
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
      // A persisted row must carry an EXPLICIT access: the create-time default
      // in validateChatChannelShareSelector must not silently promote a
      // tampered/legacy row with no access into a read-write grant. Fail closed
      // to null (the routes answer that with the generic 404).
      if (typeof (parsed as { access?: unknown }).access !== "string") return null;
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

// The ONE version a path/version share exposes, and the rule both sides
// state: a served op must name EXACTLY this version — the selector's
// `versionId`, or `main` when the selector names none. A descendant, a fork,
// or any other lineage is not admitted, on either side. The recipient runs the
// same equality against the selector it recorded when it accepted the share
// (`crates/dohc-engine-sync/src/share.rs`, `enforce_share_view_boundary`).
function targetVersionId(selector: ShareSelector): string {
  return selector.versionId ?? MAIN_VERSION_ID;
}

// The presence-topic prefix for a chat THREAD (a thread is a sub-conversation
// of a channel). The renderer sends `chat:thread:<threadId>` for a thread view;
// the bare channel wire id remains the channel-level topic.
export const CHAT_THREAD_TOPIC_PREFIX = "chat:thread:";

// Parses the threadId out of a `chat:thread:<threadId>` presence topic. Returns
// null for anything that is not EXACTLY that prefix followed by a non-empty
// threadId. Defensive: a NUL would be a presenceScopeKey separator, so a
// threadId carrying one is rejected outright (the topic parser already refuses
// control characters, but the gate must fail closed on its own). No other shape
// is a thread topic — a bare wire id, a path, or a malformed `chat:thread:`
// (empty tail) all return null.
export function parseChatThreadTopic(topic: string): string | null {
  if (typeof topic !== "string" || !topic.startsWith(CHAT_THREAD_TOPIC_PREFIX)) return null;
  const threadId = topic.slice(CHAT_THREAD_TOPIC_PREFIX.length);
  if (threadId.length === 0 || threadId.includes("\u0000")) return null;
  return threadId;
}

// MU-C1 presence gate: whether a share RECIPIENT may join the ephemeral
// awareness scope for `topic`. Fail-closed and reuses the SAME visibility
// check the durable filter uses, so presence can never fan out to a scope the
// share does not already expose. For a path/version selector a topic is a
// workspace-relative path (doc co-presence on a shared file). For a MU-C4
// chat-channel selector two topic shapes are allowed, both scoped to EXACTLY
// the granted channel:
//   - the bare granted channel wire id (channel-level co-presence), and
//   - `chat:thread:<threadId>` for a thread that BINDS to the granted channel,
//     resolved via the same forge-resistant earliest-binding resolver the
//     durable chat filter uses (`chat.threadChannelWireId`). A thread bound to
//     ANOTHER channel, an unbound/unknown thread, a forged re-bind, or a
//     malformed `chat:thread:` topic is refused. Without a resolver a thread
//     topic can never be authorized (fail closed).
// Everything the share does not positively expose is refused — a recipient of
// `a.md` cannot subscribe to presence for `b.md`, and a chat-channel member
// cannot subscribe to any other channel's or thread's presence.
export function presenceTopicAllowedForShare(
  selector: AnyShareSelector,
  topic: string,
  chat?: ChatShareThreadResolver,
): boolean {
  if (typeof topic !== "string" || topic.length === 0) return false;
  // Presence topics share one workspace namespace across path and chat routes.
  // Close cross-selector collisions: even a path share whose selected path is
  // byte-equal to an agent wire/thread topic must never enter that owner-only
  // presence scope. Server share routes always provide this owner-log resolver.
  if (chat) {
    const topicThreadId = parseChatThreadTopic(topic);
    if (topicThreadId !== null) {
      const topicChannelWireId = chat.threadChannelWireId(topicThreadId);
      if (
        typeof topicChannelWireId === "string" &&
        chat.channelKind(topicChannelWireId) === "agent"
      ) {
        return false;
      }
    } else if (chat.channelKind(topic) === "agent") {
      return false;
    }
  }
  if (isChatChannelSelector(selector)) {
    // A chat presence scope is shareable only after the owner's log proves a
    // human channel kind. This is the presence backstop for legacy or corrupt
    // grants targeting an owner-only agent channel; no resolver/unknown kind
    // also fails closed.
    if (!chat) return false;
    const channelKind = chat.channelKind(selector.channelWireId);
    if (channelKind !== "channel" && channelKind !== "dm") return false;
    // Thread-shape is decided FIRST, before any bare-wireId equality. A
    // `chat:thread:<threadId>` topic is ALWAYS routed through the forge-resistant
    // resolver — never admitted by `topic === channelWireId`. Otherwise a crafted
    // grant whose channelWireId literally equals "chat:thread:<foreignThreadId>"
    // would match the bare branch and admit presence for a thread it must not.
    // A thread topic is authorized ONLY when the thread binds (earliest binding)
    // to THIS selector's granted channel; without a resolver it is refused
    // (fail closed).
    const threadId = parseChatThreadTopic(topic);
    if (threadId !== null) {
      return chat.threadChannelWireId(threadId) === selector.channelWireId;
    }
    // A non-thread-shaped topic is channel-level co-presence: exactly the bare
    // granted channel wire id, nothing else.
    return topic === selector.channelWireId;
  }
  return pathVisibleThroughShare(selector, topic);
}

export type ShareOpDecision =
  | { allowed: false }
  | {
      allowed: true;
      // The explicit payload shape to serve. Chat and moment ops use strict
      // allowlists; version.create redacts forkSnapshots to the selector.
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

// The chat branch of the fail-closed share filter (MU-C4). Strict allowlist,
// scoped to EXACTLY the granted channel's wire id:
//   - chat.channel.create for the granted wireId (the join bootstrap);
//   - chat.thread.create carrying the granted channelWireId, provided the
//     log's earliest binding for that threadId (if any) is ALSO the granted
//     channel — a forged re-bind of a foreign thread is excluded;
//   - chat.message.append / chat.reaction.set / chat.decision.set /
//     chat.attachment.add whose thread resolves (earliest binding) to the
//     granted channel.
// Everything else — another channel's ops, file moments, secret ops, agent
// channels, version ops, workspace.init, unknown kinds — falls through to the
// caller's terminal deny. Chat ops are blob-free, so the branch never exposes
// a blob.
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
  // Agent channels use the owner's own-device lane only. A syntactically valid
  // or historical grant for one must expose no op. Requiring a positively
  // recognized human kind also makes an absent/malformed kind fail closed.
  const channelKind = chat.channelKind(selector.channelWireId);
  if (channelKind !== "channel" && channelKind !== "dm") return { allowed: false };

  if (opKind === "chat.channel.create") {
    if (collectString(record.wireId) !== selector.channelWireId) return { allowed: false };
    if (record.kind !== channelKind) return { allowed: false };
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
    // undefined = this op IS the first binding (member append path, not yet in
    // the log). Any authoritative existing state — another channel OR a null
    // file-linked binding — must equal the grant or the re-bind is rejected.
    if (bound !== undefined && bound !== selector.channelWireId) return { allowed: false };
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
              "parentMessageId",
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

  if (opKind === "chat.decision.set" || opKind === "chat.attachment.add") {
    const threadId = collectString(record.threadId);
    if (!threadId) return { allowed: false };
    if (chat.threadChannelWireId(threadId) !== selector.channelWireId) {
      return { allowed: false };
    }
    return {
      allowed: true,
      payload:
        opKind === "chat.decision.set"
          ? pickServed(record, ["threadId", "messageId", "state", "resolvedByMessageId", "atMs"])
          : pickServed(record, [
              "attachmentId",
              "threadId",
              "messageId",
              "targetKind",
              "createdAtMs",
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
    const claimedVersionId = collectString(record.versionId);
    if (claimedVersionId !== targetVersionId(selector)) return { allowed: false };
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
    // recipient's Rust share-view replay actually needs.
    // Everything else in the stored moment — author, metadata.summary,
    // metadata.correlationId, moment/object ids, lineage (before* fields),
    // and raw recorded timestamps — is dropped so nothing beyond the
    // in-selector change description crosses the share boundary. The author
    // is replaced with a neutral sync origin.
    const afterSha = collectString(record.payloadAfterBlobSha256);
    const served: Record<string, unknown> = {
      operation: typeof record.operation === "string" ? record.operation : null,
      // The MOMENT's own version, read from the stored op — deliberately not
      // `targetVersionId(selector)`, which would restate the selector and
      // stamp every served moment with the granted version whatever lineage it
      // came from. The equality above proves the two are equal here, so the
      // served value is the same in the honest case; carrying the moment's
      // field is what leaves the recipient an independent check
      // (`crates/dohc-engine-sync/src/share.rs`, `enforce_granted_version`)
      // rather than a copy of this one.
      versionId: claimedVersionId,
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
