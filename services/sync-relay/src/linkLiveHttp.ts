import type { BinaryLike } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PublicEditRelease } from "@dohc/security-contract";
import {
  encodeLiveFrameSync,
  type LiveFrameReceivePolicy,
} from "@dohc/live-session-contract/live-frame";
import type { LiveObjectBinding } from "@dohc/live-session-contract/live-object-binding";
import { readBoundedJson } from "@dohc/service-http";
import type { AwakeLiveState } from "./liveAwakeState";
import { liveBrowserActor } from "./liveBrowserContext";
import { createLinkLiveResolver } from "./linkLiveBrowserAuth";
import type { LinkAuthorityResolver } from "./linkAuthority";
import { createAccountlessPathProjection } from "./accountlessPathProjection";
import { authorizeLinkShareAction } from "./shareAuthorization";
import { hashRelayExchangeKey, verifyRelayExchangeKey } from "./linkSecurity";
import { parseNamedLiveRouteLimits, type NamedLiveRouteLimits } from "./namedLiveRoutes";
import type { SyncRelayStorage } from "./storage";
import {
  linkRefusal,
  liveNoteRefusal,
  opaqueLinkRefusal,
  sessionHostRefusal,
  type LiveNoteStanding,
  type SessionHostBlock,
} from "./linkRefusal";

// A note's early state is read before its page opens a socket, so these limits hold for a caller that never opens
// one. Each read reaches the note's host, which for a desktop host is the owner's computer. The host reads under a
// socket's opening-sync bound, so a note whose state is past STATE_MAX_BYTES is still read in full, then dropped.
const STATE_READS_AT_ONCE = 4;
const STATE_READS_PER_GRANT = 20;
const STATE_READ_WINDOW_MS = 10_000;
const STATE_MAX_BYTES = 1024 * 1024;

/**
 * Private relay metadata. The viewer receives only the selected object ID, and on the state route what the note's
 * host applied of it, as the opening sync of its socket would carry it.
 */
export function createLinkLiveHttp(options: {
  storage: SyncRelayStorage;
  linkKey: BinaryLike;
  publicEditRelease: PublicEditRelease | undefined;
  hosts: ReadonlySet<string>;
  publicOrigin: string;
  exchangeKey: string;
  limits: NamedLiveRouteLimits;
  /** Whether the session host cannot continue the document until its owner or operator acts. */
  sessionHostBlocked?: (document: {
    workspaceId: string;
    objectId: string;
  }) => SessionHostBlock | undefined;
  /** Where the note stands while it is not live, when its record answers. */
  liveNote?: (document: { workspaceId: string; objectId: string }) => LiveNoteStanding | undefined;
  /** Authenticates a connected agent, as the link's other routes do. */
  linkAuthority: Pick<LinkAuthorityResolver, "resolve">;
  /**
   * What the note's current host applied, if it holds the note awake. Without it the state route refuses. It reads
   * under the bound a socket's opening sync reads under, so the route drops a larger state rather than ask for less.
   */
  readAwakeState?: (
    binding: LiveObjectBinding,
    signal: AbortSignal,
  ) => Promise<AwakeLiveState | undefined>;
  /** The frame limits a browser receives an opening sync under. */
  frames?: LiveFrameReceivePolicy;
  nowMs?: () => number;
}) {
  const limits = parseNamedLiveRouteLimits(options.limits),
    hosts = new Set(options.hosts);
  const origin = new URL(options.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== options.publicOrigin ||
    options.exchangeKey.length < 32 ||
    !hosts.size
  )
    throw new TypeError("Invalid link live metadata configuration.");
  const exchangeHash = hashRelayExchangeKey(options.exchangeKey),
    resolver = createLinkLiveResolver(options);
  const refused = opaqueLinkRefusal,
    nowMs = options.nowMs ?? Date.now,
    asleep = () =>
      new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  let pending = 0,
    stateReads = 0,
    windowStartMs = Number.NEGATIVE_INFINITY;
  const grantReads = new Map<string, number>();
  // Whether a grant may read one more state in this window. Every grant's count restarts together.
  const admitStateRead = (grantId: string) => {
    if (nowMs() - windowStartMs >= STATE_READ_WINDOW_MS) {
      windowStartMs = nowMs();
      grantReads.clear();
    }
    const count = grantReads.get(grantId) ?? 0;
    if (count >= STATE_READS_PER_GRANT) return false;
    grantReads.set(grantId, count + 1);
    return true;
  };
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      state = url.pathname === "/sync/live/link-document-state",
      document = state || url.pathname === "/sync/live/link-document";
    if (
      (!document && url.pathname !== "/sync/live/link-session") ||
      (state && (!options.readAwakeState || !options.frames)) ||
      url.search ||
      request.method !== "POST" ||
      !hosts.has(request.headers.get("host") ?? "") ||
      request.headers.get("origin") !== options.publicOrigin ||
      !verifyRelayExchangeKey(request.headers.get("x-dohc-relay-exchange-key"), exchangeHash) ||
      request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
        "application/json" ||
      request.signal.aborted ||
      pending >= limits.maxPendingRequests
    )
      return refused();
    pending++;
    const signal = AbortSignal.any([
      request.signal,
      options.storage.unavailable,
      AbortSignal.timeout(limits.upgradeTimeoutMs),
    ]);
    try {
      const input: unknown = await readBoundedJson(request, limits.maxRequestBytes, signal);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).sort().join() !== (document ? "discriminator,path" : "discriminator")
      )
        return refused();
      const value = input as Record<string, unknown>;
      if (typeof value.discriminator !== "string") return refused();
      const context = await resolver.resolve(
        new Request(request.url, { headers: request.headers, signal }),
        value.discriminator,
        document ? "read" : "edit",
      );
      signal.throwIfAborted();
      if (!context) return refused();
      const body = (() => {
        if (document) {
          if (
            typeof value.path !== "string" ||
            value.path.length > 1024 ||
            !/\.md$/i.test(value.path)
          )
            return null;
          const authority = authorizeLinkShareAction({
            storage: options.storage,
            grantId: context.grantId,
            action: "read",
          });
          if (!authority.ok) return null;
          const path = createAccountlessPathProjection(authority.effectiveSelector).resolvePath(
            value.path,
          );
          if (path === null) return null;
          const objectId = options.storage.objectIdAtPathInVersion({
            workspaceId: context.workspaceId,
            versionId: authority.effectiveSelector.versionId ?? "main",
            path,
          });
          if (!objectId) return null;
          if (authority.effectiveSelector.access === "view") return linkRefusal("link_view_access");
          if (authority.effectiveSelector.access === "comment")
            return linkRefusal("link_comment_access");
          if (
            !authorizeLinkShareAction({
              storage: options.storage,
              grantId: context.grantId,
              action: "live-edit",
            }).ok
          )
            return null;
          const current = options.storage.resolveLiveObjectHostBinding(context, objectId);
          const block = options.sessionHostBlocked?.({
            workspaceId: context.workspaceId,
            objectId,
          });
          // A note paused after its file moved has no binding, and only its owner can start it again.
          if (
            current.kind === "refused" &&
            (current.reason === "host-unavailable" || current.reason === "stale-document")
          ) {
            return options.liveNote?.({ workspaceId: context.workspaceId, objectId })
              ? { objectId }
              : sessionHostRefusal(block ?? "stopped");
          }
          if (current.kind !== "current" || current.binding.currentPath !== path) return null;
          const note = options.liveNote?.({ workspaceId: context.workspaceId, objectId });
          const refused = liveNoteRefusal(note === "starting" ? undefined : note, block);
          if (refused) return refused;
          // The state comes only where a ticket would: a link that takes no more browsers refuses this one.
          if (state && options.storage.liveLinkFull(context)) return linkRefusal("link_full");
          return { objectId, current };
        }
        // Only a browser gateway opens a link session; an agent has no profile.
        if ("agentConnectionId" in context) return null;
        // Ticket minting has already enrolled this profile before a gateway can open.
        const principal = options.storage.getLinkPrincipalForGrantProfile(
          context.grantId,
          context.profileTokenHash,
        );
        const session = options.storage.findLinkSessionByCapabilityHash(context.capabilityHash);
        if (
          !principal ||
          principal.blockedAtMs !== null ||
          session?.principalId !== principal.principalId ||
          session.sessionId !== context.sessionId
        )
          return null;
        return {
          kind: "link",
          workspaceId: context.workspaceId,
          shareId: context.shareId,
          grantId: context.grantId,
          principalId: principal.principalId,
          sessionId: context.sessionId,
        };
      })();
      signal.throwIfAborted();
      if (!body) return refused();
      if (body instanceof Response) return body;
      if (state && "objectId" in body) {
        if (!body.current || options.storage.liveNoteFormatOff(body.current.binding))
          return asleep();
        if (stateReads >= STATE_READS_AT_ONCE || !admitStateRead(context.grantId)) return asleep();
        stateReads++;
        try {
          return await readState(context, body.objectId, body.current, signal);
        } finally {
          stateReads--;
        }
      }
      const encoded = JSON.stringify("objectId" in body ? { objectId: body.objectId } : body);
      if (Buffer.byteLength(encoded) > limits.maxResponseBytes) return refused();
      return new Response(encoded, {
        headers: { "content-type": "application/json", "cache-control": "private, no-store" },
      });
    } catch {
      return refused();
    } finally {
      pending--;
    }
  };

  // The note's state as its host applied it, shown as this reader's socket would show it. A reader's browser enrolls
  // only with its first ticket, so this reads the binding as the ticket does, before enrollment. No state when the host
  // does not hold the note awake, or when its binding, its host or what this reader is shown changed during the read.
  async function readState(
    context: Parameters<typeof liveBrowserActor>[0],
    objectId: string,
    before: Extract<
      ReturnType<SyncRelayStorage["resolveLiveObjectHostBinding"]>,
      { kind: "current" }
    >,
    signal: AbortSignal,
  ): Promise<Response> {
    const read = await options.readAwakeState!(before.binding, signal);
    signal.throwIfAborted();
    const after = options.storage.resolveLiveObjectHostBinding(context, objectId);
    if (
      !read ||
      read.hostVector.byteLength + read.missingStateUpdate.byteLength > STATE_MAX_BYTES ||
      after.kind !== "current" ||
      !isDeepStrictEqual(read.binding, before.binding) ||
      !isDeepStrictEqual(read.coordinate, after.host) ||
      !isDeepStrictEqual(after, before)
    )
      return asleep();
    let bytes: Uint8Array;
    try {
      bytes = encodeLiveFrameSync(
        {
          binding: before.view,
          hostVector: read.hostVector,
          missingStateUpdate: read.missingStateUpdate,
        },
        options.frames!,
      );
    } catch {
      return asleep();
    }
    return new Response(Buffer.from(bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "private, no-store",
        "x-dohc-live-object-id": objectId,
        "x-dohc-live-applied-through": String(read.appliedThroughJournalCursor),
      },
    });
  }
}
