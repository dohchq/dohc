import {
  PresencePublishRequestPayload, PresencePollPayload, PresenceCancelPayload, PresenceResult,
  type PresenceScopeInput,
} from "./bridgeContract";
import { CHANNELS } from "./channels";
import { createPresencePollRegistry } from "../collab/presencePollRegistry";
import { PresenceMutationOwner } from "../collab/presenceMutationOwner";
// The relay presence transport has no DOM or React dependency. Main reuses its
// wire contract and holds the bearer token; renderers call these IPC handlers.
import {
  createRelayPresenceTransport, type PresenceScope as RelayPresenceScope,
} from "../renderer/collab/presenceChannel";
import type { RendererWorkspaceSender, RendererWorkspaceSessionOwner } from "../window/rendererWorkspaceSessionOwner";
import type { CloudCredentials } from "../workspaces/cloudCredentialStore";
import type { RegistryEntry } from "../workspaces/registryStore";
import { workspaceRemoteMatchesCredentials } from "../workspaces/chatRelayIdentity";
import { relayFetchWithTimeout, RELAY_FETCH_TIMEOUT_MS } from "../workspaces/sharedChannels";

export function createPresenceIpc<Sender extends RendererWorkspaceSender>(dependencies: {
  warmCredentialCache(): Promise<void>;
  currentCredentials(): CloudCredentials | null;
  normalizeServerUrl(url: string): string;
  findWorkspace(workspaceId: string): RegistryEntry | null;
}) {
  const { warmCredentialCache, currentCredentials, normalizeServerUrl, findWorkspace } = dependencies;

  // Presence (MU-C5) relay bounds. Publish/leave are quick, so a 15s cap frees a
  // hung socket. The poll is a long-poll: its own AbortSignal (presenceCancel)
  // governs, and this safety cap only fires if the relay stalls past its hold
  // (<=30s) so an IPC invoke can never dangle forever.
  const PRESENCE_POLL_SAFETY_MS = 35_000;
  // In-flight presence long-polls, owned by (senderId + pollId) so a poll can only
  // be cancelled/superseded by its own window, and bounded so a renderer can't
  // open unbounded relay long-polls / controllers / timers.
  const presencePollRegistry = createPresencePollRegistry();
  const presenceMutationOwner = new PresenceMutationOwner<Sender>();
  // A stable ownership key so one window holds at most one poll per (scope, topic):
  // a new poll for the same key supersedes (aborts) the prior long-poll.
  function presenceScopeTopicKey(scope: PresenceScopeInput, topic: string): string {
    return JSON.stringify(
      scope.kind === "workspace"
        ? ["w", scope.workspaceId, topic]
        : ["s", scope.workspaceId, scope.shareId, topic],
    );
  }

  function presenceMutationKey(
    scope: PresenceScopeInput,
    topic: string,
    clientId: string,
  ): string {
    return JSON.stringify([presenceScopeTopicKey(scope, topic), clientId]);
  }
  async function presenceRelayTransportForScope(
    scope: PresenceScopeInput,
  ): Promise<ReturnType<typeof createRelayPresenceTransport> | null> {
    await warmCredentialCache();
    const credentials = currentCredentials();
    if (!credentials?.relayUrl) return null;
    const baseUrl = normalizeServerUrl(credentials.relayUrl);
    const token = credentials.token;
    const fetchImpl = relayFetchWithTimeout(RELAY_FETCH_TIMEOUT_MS);
    let relayScope: RelayPresenceScope;
    if (scope.kind === "workspace") {
      const entry = findWorkspace(scope.workspaceId);
      const remote = entry?.remote;
      if (!remote || !workspaceRemoteMatchesCredentials(remote, credentials)) {
        return null;
      }
      relayScope = {
        kind: "workspace",
        workspaceId: entry.workspaceId,
      };
    } else {
      const joined = (findWorkspace(scope.workspaceId)?.sharedChannels ?? []).some(
        (channel) =>
          channel.shareId === scope.shareId && channel.ended !== true,
      );
      if (!joined) return null;
      relayScope = { kind: "share", shareId: scope.shareId };
    }
    return createRelayPresenceTransport({
      baseUrl,
      token,
      scope: relayScope,
      fetch: fetchImpl,
    });
  }

  function registerPresenceIpcHandlers<Event extends { sender: Sender }>(dependencies: {
    registerHandler(channel: string, handler: (event: Event, payload: unknown) => unknown): void;
    assertTrustedSender(event: Event): void;
    rendererWorkspaceSessions: Pick<RendererWorkspaceSessionOwner<Sender>, "current" | "currentForDocument">;
  }): void {
    const { registerHandler, assertTrustedSender, rendererWorkspaceSessions } = dependencies;

    // Ephemeral presence (MU-C5): the renderer never receives the relay bearer
    // token — its presence transport calls presencePublish/presencePoll/
    // presenceCancel, and MAIN (the sole token holder) makes the actual relay
    // presence request. Scope is authorized here before the relay (which
    // re-authorizes from the bearer anyway): a workspace scope must be a synced
    // workspace this account owns; a share scope must be a grant this account has
    // joined. An unauthorized/unavailable scope returns null (renderer → dormant),
    // never a leak.
    //
    registerHandler(CHANNELS.presencePublish, async (event, payload) => {
      assertTrustedSender(event);
      const input = PresencePublishRequestPayload.parse(payload);
      const rendererSession = rendererWorkspaceSessions.currentForDocument(
        event.sender,
        input.rendererDocumentId,
      );
      if (
        !rendererSession ||
        input.scope.workspaceId !== rendererSession.workspaceId
      ) {
        return PresenceResult.parse({ ok: false, reason: "unavailable" });
      }
      const key = presenceMutationKey(input.scope, input.topic, input.clientId);
      const resolveLeave = async (): Promise<() => Promise<void>> => {
        const transport = await presenceRelayTransportForScope(input.scope);
        if (!transport) throw new Error("Presence scope is unavailable");
        return () =>
          transport.leave({ topic: input.topic, clientId: input.clientId });
      };
      try {
        if (input.leave === true) {
          await presenceMutationOwner.leave(
            rendererSession,
            key,
            input.incarnationId,
            resolveLeave,
          );
          // A leave has no snapshot to echo; report an empty one so the renderer
          // clears without treating it as a failure.
          return PresenceResult.parse({ ok: true, snapshot: { version: 0, peers: [] } });
        }
        // The exact renderer lease owns this mutation before scope resolution
        // warms credentials. Retirement serializes its leave behind any request
        // that may already have landed at the relay.
        const snapshot = await presenceMutationOwner.publish(
          rendererSession,
          key,
          input.incarnationId,
          {
            resolve: async () => {
              const transport = await presenceRelayTransportForScope(input.scope);
              if (!transport) throw new Error("Presence scope is unavailable");
              return {
                publish: () =>
                  transport.publish({
                    topic: input.topic,
                    clientId: input.clientId,
                    state: input.state ?? null,
                  }),
                leave: () =>
                  transport.leave({
                    topic: input.topic,
                    clientId: input.clientId,
                  }),
              };
            },
          },
        );
        if (!snapshot) {
          return PresenceResult.parse({ ok: false, reason: "unavailable" });
        }
        return PresenceResult.parse({ ok: true, snapshot });
      } catch {
        // Presence is best-effort: a transient relay failure is "unavailable",
        // never a thrown IPC error.
        return PresenceResult.parse({ ok: false, reason: "unavailable" });
      }
    });

    registerHandler(CHANNELS.presencePoll, async (event, payload) => {
      assertTrustedSender(event);
      const input = PresencePollPayload.parse(payload);
      const rendererSession = rendererWorkspaceSessions.current(event.sender);
      if (
        !rendererSession ||
        input.scope.workspaceId !== rendererSession.workspaceId
      ) {
        return PresenceResult.parse({ ok: false, reason: "aborted" });
      }
      // Register the controller before any await: scope resolution warms the
      // credential cache, and a presenceCancel arriving during that window must
      // abort this poll promptly (workspace-switch repaint), not wait out the 35s
      // safety cap. Ownership keys on (senderId + pollId) so only this window can
      // cancel it, and at most one poll runs per (sender, scope, topic).
      const handle = presencePollRegistry.begin(
        event.sender.id,
        input.pollId,
        presenceScopeTopicKey(input.scope, input.topic),
      );
      // Safety timeout caps a hung relay (the hold is <=30s; give headroom then
      // abort) so the IPC invoke can never dangle forever.
      const safety = setTimeout(() => handle.abort(), PRESENCE_POLL_SAFETY_MS);
      try {
        const transport = await presenceRelayTransportForScope(input.scope);
        if (!transport) return PresenceResult.parse({ ok: false, reason: "unavailable" });
        // A cancel could have landed while scope was resolving.
        if (handle.signal.aborted || !rendererSession.isCurrent()) {
          return PresenceResult.parse({ ok: false, reason: "aborted" });
        }
        const snapshot = await transport.poll({
          topic: input.topic,
          since: input.since,
          signal: handle.signal,
        });
        if (!rendererSession.isCurrent()) {
          return PresenceResult.parse({ ok: false, reason: "aborted" });
        }
        return PresenceResult.parse({ ok: true, snapshot });
      } catch {
        // Aborted (cancel/switch/timeout) vs a relay error: both degrade to
        // dark, but "aborted" tells the renderer this was an intentional stop.
        return PresenceResult.parse({
          ok: false,
          reason: handle.signal.aborted ? "aborted" : "unavailable",
        });
      } finally {
        clearTimeout(safety);
        // Removes only this poll's entry — a superseding poll under the same id is
        // left untouched.
        handle.release();
      }
    });

    registerHandler(CHANNELS.presenceCancel, (event, payload) => {
      assertTrustedSender(event);
      const input = PresenceCancelPayload.parse(payload);
      if (!rendererWorkspaceSessions.current(event.sender)) {
        return undefined;
      }
      // Only aborts a poll this sender owns; a cancel for another window's pollId
      // is a no-op.
      presencePollRegistry.cancel(event.sender.id, input.pollId);
      return undefined;
    });
  }

  return {
    presencePollRegistry,
    presenceMutationOwner,
    presenceRelayTransportForScope,
    registerPresenceIpcHandlers,
  };
}
