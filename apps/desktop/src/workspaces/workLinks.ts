import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";
import { buildWorkLinkUrl, workLinkServerOrigin, type WorkLink } from "@dohc/workspace-contracts/work-links";
import type { WorkLinkPlace, WorkspaceSummary } from "../ipc/bridgeContract";
import { offersWorkLinks } from "../ipc/workLinkOffer";

type WorkReferenceResolution = Awaited<ReturnType<VersionedLiveAdapter["resolveWorkReference"]>>;

const ENGINE_UNAVAILABLE = "The workspace engine is not running.";

/**
 * Work links for this computer's workspaces. A link's server is the origin of
 * the server its workspace syncs with. Main finds it from the registry; the
 * renderer never names it.
 */
export function createWorkLinks<Entry extends { readonly workspaceId: string; readonly remote?: { readonly serverUrl: string } }>(deps: {
  workspaces(): readonly Entry[];
  summaryOf(entry: Entry): Pick<WorkspaceSummary, "sync">;
  /** Null when the engine is not running. */
  resolveReference(entry: Entry, reference: string): Promise<WorkReferenceResolution | null>;
}) {
  function serverOf(entry: Entry): string | null {
    return offersWorkLinks(deps.summaryOf(entry)) && entry.remote ? workLinkServerOrigin(entry.remote.serverUrl) : null;
  }

  return {
    /**
     * The link to a message in `entry`, or null when the workspace does not
     * sync. `mint` makes the message's work reference, or answers null when
     * the engine is not running.
     */
    async messageLink(entry: Entry, mint: () => Promise<string | null>): Promise<string | null> {
      const server = serverOf(entry);
      if (server === null) return null;
      const reference = await mint();
      if (reference === null) throw new Error(ENGINE_UNAVAILABLE);
      return buildWorkLinkUrl({ server, reference });
    },

    /**
     * The message a link names, from the workspaces that sync with its
     * server, the window's own workspace first. A workspace that cannot answer
     * is skipped. Null when none holds a message that is still there. The
     * message's chat is the Group or DM its thread is in, or null for a
     * file's conversation.
     */
    async resolve(link: WorkLink, currentWorkspaceId: string | undefined): Promise<WorkLinkPlace | null> {
      const candidates = deps.workspaces()
        .filter((entry) => serverOf(entry) === link.server)
        .sort((a, b) => Number(b.workspaceId === currentWorkspaceId) - Number(a.workspaceId === currentWorkspaceId));
      for (const entry of candidates) {
        const found = await deps.resolveReference(entry, link.reference).catch(() => null);
        if (found?.status !== "found" || found.state === "deleted" || found.target.kind !== "message") continue;
        const { threadId, messageId, channelId } = found.target;
        return { workspaceId: entry.workspaceId, channelId: channelId ?? null, threadId, messageId };
      }
      return null;
    },
  };
}

/**
 * Opens the work links the OS hands dohc. Each link takes the next activation
 * when it arrives. A link whose lookup finishes after a newer link arrived
 * opens nothing, so the newest link always wins. Window switches run one at a
 * time: a window still loading for an older link finishes that switch before
 * a newer link switches it again.
 */
export function createWorkLinkActivations<Shown>(deps: {
  resolve(link: WorkLink): Promise<WorkLinkPlace | null>;
  /** Shows the place's workspace in a window. Null when this computer no longer lists it. */
  activate(place: WorkLinkPlace): Promise<Shown | null>;
  /** Opens the message in the window that now shows its workspace. */
  deliver(shown: Shown, place: WorkLinkPlace): void;
  /** Shows dohc when no workspace here holds the message. */
  showDohc(): Promise<void>;
}) {
  let latest = 0;
  let switching: Promise<void> = Promise.resolve();

  async function switchTo(activation: number, place: WorkLinkPlace | null): Promise<void> {
    if (activation !== latest) return;
    const shown = place === null ? null : await deps.activate(place);
    if (activation !== latest) return;
    if (place === null || shown === null) return await deps.showDohc();
    deps.deliver(shown, place);
  }

  return {
    async open(link: WorkLink): Promise<void> {
      const activation = ++latest;
      const place = await deps.resolve(link);
      if (activation !== latest) return;
      const turn = switching.then(() => switchTo(activation, place));
      switching = turn.catch(() => {});
      return await turn;
    },
  };
}
