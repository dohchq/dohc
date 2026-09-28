import { Bot } from "lucide-react";
import type { CustomizeTarget } from "./settings/customize";
import { SecondaryButton } from "./ui/controls";
import type { AgentSetupSummary } from "./workbench/ChatsView";

/** A job handed to the person's own agent. */
export type AgentRequest =
  | { kind: "settings"; target?: CustomizeTarget }
  | { kind: "app" }
  // A Collection's own files, each with what it holds.
  | { kind: "collection"; name: string; files: readonly CollectionFile[] };

export interface CollectionFile {
  path: string;
  holds: string;
}

/** Hands a job to the person's agent. `ready` is false when none is set up. */
export interface AskAgent {
  ready: boolean;
  ask: (request: AgentRequest) => void;
  // Opens the settings where a person sets up their agent.
  setUp: () => void;
}

/** The Agents list's rule: a name to post as, and a runner that starts it. */
export function agentIsSetUp(setup: AgentSetupSummary): boolean {
  return Boolean(setup.agentName && setup.runnerEnabled);
}

/**
 * The message dohc puts in the agent's chat. It names the file the agent
 * changes and ends where the person says what they want; the person sends it.
 */
export function agentRequestText(
  request: AgentRequest,
  where: { settingsFile: string; workspaceId: string },
): string {
  const lines =
    request.kind === "collection"
      ? [
          `Change my dohc Collection "${request.name}" in this workspace.`,
          ...request.files.map((file) => `Its ${file.holds} are in ${file.path}.`),
          "dohc applies each file when it is saved.",
        ]
      : request.kind === "app"
      ? [
          "Make me a new app in this workspace: a new folder with an index.html.",
          `Then pin it to my dohc sidebar: add the folder's path to "sidebar" > "pinnedApps" > "${where.workspaceId}" in my dohc settings file, ${where.settingsFile}.`,
        ]
      : [
          request.target
            ? `Change my dohc ${request.target.subject} settings. They are the ${request.target.keys.map((key) => `"${key}"`).join(" and ")} ${request.target.keys.length === 1 ? "key" : "keys"} in my dohc settings file, ${where.settingsFile}.`
            : `Change my dohc settings. They are in my dohc settings file, ${where.settingsFile}.`,
          "dohc applies the file when it is saved.",
        ];
  return [...lines, "What I want: "].join("\n");
}

export function AskAgentButton(props: {
  askAgent: AskAgent;
  request: AgentRequest;
  label?: string;
}) {
  if (!props.askAgent.ready) {
    return (
      <span data-testid="ask-agent-setup" className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted">You have no agent set up.</span>
        <SecondaryButton size="compact" onClick={props.askAgent.setUp}>
          Set up an agent
        </SecondaryButton>
      </span>
    );
  }
  return (
    <SecondaryButton
      size="compact"
      data-testid="ask-agent"
      onClick={() => props.askAgent.ask(props.request)}
      className="flex shrink-0 items-center gap-1"
    >
      <Bot size={12} aria-hidden />
      {props.label ?? "Ask my agent"}
    </SecondaryButton>
  );
}
