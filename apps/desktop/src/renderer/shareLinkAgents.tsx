import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LINK_SECRET_PATTERN } from "@dohc/security-contract/wire-patterns";
import type { RelayShareLinkAgent } from "../ipc/bridgeContract";
import { withErrorWords } from "../ipc/errorWords";
import { bridge } from "./bridge";
import {
  agentDisconnectIdentity,
  disconnectedAgentKey,
  type ShareRemovalNotices,
} from "./shell/useShareRemovalNotices";
import { GhostButton, RetryRow, SecondaryButton, SectionLabel } from "./ui/controls";
import type { CopySecret } from "./ui/CopyButton";
import { ChatAvatar } from "./workbench/ChatAvatar";
import { neutralPresentation } from "./workbench/actorPresentation";

// The link's MCP address, where an agent signs in with the link. It carries
// the link's secret, so dohc keeps it no longer than the link it came from.
export const AGENT_ADDRESS_SECRET: CopySecret = {
  what: "the address for an agent",
  again: "Reset the link in Share to get a new one.",
};

/**
 * The MCP address for a share link the relay returned: the same share-web
 * origin, at `/mcp/s/<secret>`. Null for anything that is not a share link.
 */
export function agentAddressFor(linkUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(linkUrl);
  } catch {
    return null;
  }
  const secret = url.hash.slice(1);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname !== "/s/" || url.search || url.username || url.password || !LINK_SECRET_PATTERN.test(secret)) return null;
  return `${url.origin}/mcp/s/${secret}`;
}

export const LINK_AGENTS_FAILED = "dohc could not load this link's agents.";

type AgentLink = { workspaceId: string; shareId: string; grantId: string };
type AgentDisconnect = { kind: "pending" } | { kind: "refused"; words: string } | { kind: "gone" };
const GONE: AgentDisconnect = { kind: "gone" };

export type LinkAgentDisconnects = {
  // What this dialog's Disconnect, or any while this workspace stayed open, did to the agent.
  stateOf(link: AgentLink, connectionId: string): AgentDisconnect | undefined;
  disconnect(link: AgentLink, agent: RelayShareLinkAgent): void;
};

/**
 * The Share dialog's Disconnects. They belong to the dialog, not to one
 * link's list, so leaving the link tab and coming back keeps a Disconnect
 * running and shows its failure in place. Only a Disconnect that fails after
 * the dialog closed goes to the shell, with Try again. A success, here or
 * from that Try again, reaches the shell's set of disconnected agents, so
 * every list leaves the agent out.
 */
export function useLinkAgentDisconnects(
  notices: ShareRemovalNotices | undefined,
  disconnected: ReadonlySet<string> | undefined,
): LinkAgentDisconnects {
  const [rows, setRows] = useState<ReadonlyMap<string, AgentDisconnect>>(() => new Map());
  const open = useRef(false);
  const shell = useRef(notices);
  shell.current = notices;
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);

  function settle(key: string, row: AgentDisconnect) {
    if (open.current) setRows((current) => new Map(current).set(key, row));
  }

  async function run(link: AgentLink, agent: RelayShareLinkAgent) {
    const named = { workspaceId: link.workspaceId, grantId: link.grantId, connectionId: agent.connectionId };
    const key = disconnectedAgentKey(named);
    settle(key, { kind: "pending" });
    try {
      await bridge().disconnectRelayShareLinkAgent({ ...link, connectionId: agent.connectionId });
      settle(key, GONE);
      shell.current?.agentDisconnected(named);
    } catch (cause) {
      const message = `dohc could not disconnect ${agentName(agent)}.`;
      if (open.current) {
        settle(key, { kind: "refused", words: withErrorWords(message, cause) });
        return;
      }
      shell.current?.failed({
        workspaceId: link.workspaceId,
        message,
        cause,
        retry: () => void run(link, agent),
        identity: agentDisconnectIdentity(link.grantId, agent.connectionId),
      });
    }
  }

  return {
    stateOf(link, connectionId) {
      const key = disconnectedAgentKey({ workspaceId: link.workspaceId, grantId: link.grantId, connectionId });
      return disconnected?.has(key) ? GONE : rows.get(key);
    },
    disconnect: (link, agent) => void run(link, agent),
  };
}

const shortTimestamp = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

/**
 * The agents connected through one link, with Disconnect. Nothing shows
 * until the relay names an agent or another page. Each answer lands only on
 * the link and read that asked for it; the parent keys this list by
 * workspace and link. A read that failed is one line with Try again.
 */
export function LinkAgentsList(props: {
  workspaceId: string;
  shareId: string;
  grantId: string;
  // Bumped when the links change, so Reset and End show here too.
  revision: number;
  disconnects: LinkAgentDisconnects;
}) {
  const [agents, setAgents] = useState<readonly RelayShareLinkAgent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null | undefined>(undefined);
  // The read in flight. Show more and Try again wait for it, so a page
  // cannot land on a list read again from the start.
  const [reading, setReading] = useState<"start" | "more" | null>(null);
  const read = useRef(0);
  const link = { workspaceId: props.workspaceId, shareId: props.shareId, grantId: props.grantId };

  async function readPage(token: number, cursor?: string) {
    setReading(cursor === undefined ? "start" : "more");
    try {
      const page = await bridge().listRelayShareLinkAgents({ ...link, ...(cursor === undefined ? {} : { cursor }) });
      if (read.current !== token) return;
      setAgents((current) => cursor === undefined ? page.agents
        : [...current, ...page.agents.filter((agent) => !current.some((shown) => shown.connectionId === agent.connectionId))]);
      setNextCursor(page.nextCursor);
      setFailedCursor(undefined);
    } catch {
      if (read.current !== token) return;
      setFailedCursor(cursor ?? null);
    } finally {
      if (read.current === token) setReading(null);
    }
  }

  useEffect(() => {
    const token = ++read.current;
    void readPage(token);
    return () => {
      read.current += 1;
    };
  }, [props.revision]);

  // A read that started before a Disconnect finished must not bring its agent back.
  const shown = agents.filter((agent) => props.disconnects.stateOf(link, agent.connectionId)?.kind !== "gone");
  if (shown.length === 0 && failedCursor === undefined && nextCursor === null) return null;
  return (
    <section
      data-testid={`share-link-agents-${props.grantId}`}
      aria-labelledby={`share-link-agents-heading-${props.grantId}`}
      className="flex flex-col"
    >
      <div className="flex h-6 items-center gap-2">
        <SectionLabel as="h4" id={`share-link-agents-heading-${props.grantId}`} className="m-0">Agents</SectionLabel>
        {shown.length > 0 ? (
          <span className="text-[12px] text-subtle">{shown.length}{nextCursor !== null ? "+" : ""}</span>
        ) : null}
      </div>
      {shown.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {shown.map((agent) => {
            const state = props.disconnects.stateOf(link, agent.connectionId);
            const busy = state?.kind === "pending";
            const failure = state?.kind === "refused" ? state.words : undefined;
            const name = agentName(agent);
            return (
              <li
                key={agent.connectionId}
                data-testid={`share-link-agent-${agent.connectionId}`}
                className="flex min-h-8 items-center gap-2 py-1"
              >
                <ChatAvatar name={name} kind="link" linkAgent presentation={neutralPresentation} size="comment" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] text-ink" title={name}>
                    <bdi>{name}</bdi>
                    <span className="sr-only">, agent</span>
                  </span>
                  <span className="text-[12px] text-subtle">
                    {agent.reportedName === null ? "The agent reported no name" : "Name reported by the agent"}
                    {" · "}
                    {agent.lastActionAtMs === null
                      ? `Signed in ${shortTimestamp.format(agent.connectedAtMs)}`
                      : `Last action ${shortTimestamp.format(agent.lastActionAtMs)}`}
                  </span>
                  {failure ? (
                    <p
                      role="alert"
                      data-testid={`share-link-agent-error-${agent.connectionId}`}
                      className="m-0 flex items-start gap-1.5 text-[12px] leading-4 text-muted"
                    >
                      <TriangleAlert size={12} aria-hidden className="mt-0.5 shrink-0 text-danger" />
                      <span>{failure}</span>
                    </p>
                  ) : null}
                </div>
                <SecondaryButton
                  size="row"
                  disabled={busy}
                  aria-busy={busy || undefined}
                  aria-label={`${busy ? "Disconnecting" : "Disconnect"} ${name}`}
                  data-testid={`share-link-agent-disconnect-${agent.connectionId}`}
                  onClick={() => props.disconnects.disconnect(link, agent)}
                >
                  {busy ? "Disconnecting…" : "Disconnect"}
                </SecondaryButton>
              </li>
            );
          })}
        </ul>
      ) : null}
      {failedCursor !== undefined ? (
        <RetryRow
          testId={`share-link-agents-retry-${props.grantId}`}
          disabled={reading !== null}
          onRetry={() => void (failedCursor === null ? readPage(++read.current) : readPage(read.current, failedCursor))}
        >
          {LINK_AGENTS_FAILED}
        </RetryRow>
      ) : nextCursor !== null ? (
        <GhostButton
          className="self-start"
          disabled={reading !== null}
          onClick={() => void readPage(read.current, nextCursor)}
        >
          {reading === "more" ? "Loading agents…" : "Show more agents"}
        </GhostButton>
      ) : null}
    </section>
  );
}

// The name the agent's client reported, or "Agent", as the consent page shows it.
export function agentName(agent: Pick<RelayShareLinkAgent, "reportedName">): string {
  return agent.reportedName ?? "Agent";
}
