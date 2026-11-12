import { useState, type ReactNode } from "react";
import { CircleAlert, CloudOff, Link, LoaderCircle, Plug } from "lucide-react";
import { MAX_PREFERRED_NAME_LENGTH, preferredNameFromInput } from "@dohc/workspace-contracts/chat-identity-values";
import type { AgentHue } from "@dohc/workspace-contracts/agent-hues";
import { AGENT_TOOLS, type AgentLaunch } from "../../agents/agentToolCatalog";
import { agentHandle, agentNameTaken, newAgentName, type DesktopUserSettings } from "../../settings/userSettings";
import { AgentLinkAppMenu } from "../agentLinkApps";
import { Overlay } from "../Overlay";
import { CopyButton } from "../ui/CopyButton";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { HueControl, SwitchControl } from "./SettingRow";
import { ToolReadiness, type ReadinessTone } from "./ToolReadiness";

export type ToolTileState =
  | { status: "ready"; executable: string }
  | { status: "sign-in" | "update" | "not-found" };

const TILE_STATE: Record<ToolTileState["status"], { text: string; tone: ReadinessTone }> = {
  ready: { text: "Ready", tone: "ready" },
  "sign-in": { text: "Sign in first", tone: "blocked" },
  update: { text: "Update first", tone: "blocked" },
  "not-found": { text: "Not found", tone: "unknown" },
};

export type RunsWith = "claude" | "codex" | "mcp" | "link";

/**
 * The Agent link choice: none without a server account; while dohc reads the
 * account's agents; when it could not; or the server, the open workspace and
 * its link, which is null while the workspace doesn't sync to that server.
 */
export type AgentLinkChoice =
  | { status: "no-server" }
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; host: string; workspaceName: string; link: string | null };

/** What the sheet adds: the agent's fields, and the base of its id. */
export type NewAgent = {
  name: string;
  hue: AgentHue;
  enabled: boolean;
  launch?: AgentLaunch;
  idBase: string;
};

function nameProblem(agents: DesktopUserSettings["agents"], value: string, takenElsewhere: (name: string) => boolean): string | null {
  try {
    const name = preferredNameFromInput(value);
    if (!name) return "Enter an agent name.";
    return agentNameTaken(agents, "", name) || takenElsewhere(name) ? "Another agent has this name." : null;
  } catch {
    return "This name can't be used.";
  }
}

const baseName = (choice: RunsWith) => choice === "mcp" || choice === "link" ? "Agent" : AGENT_TOOLS.find((entry) => entry.id === choice)!.name;

/**
 * Add agent: name and color, then what the agent runs with. Claude Code and
 * Codex run on this computer when their switch is on. Another agent connects
 * through MCP with the config shown here, under the id it will get. Agent
 * link adds nothing here: it copies the link an agent signs in with, and the
 * agent takes its name on the sign-in page.
 */
export function AddAgentSheet(props: {
  agents: DesktopUserSettings["agents"];
  // Each tool's readiness, or null while dohc looks or when it could not.
  toolState: (tool: "claude" | "codex") => ToolTileState | null;
  detectionFailed: boolean;
  hue: AgentHue;
  // The MCP config for an agent with this id, or null when this workspace has none.
  mcpConfig: (agentId: string) => string | null;
  mcpUnavailable: string | null;
  // The id an agent you run would get.
  mcpAgentId: string;
  agentLink: AgentLinkChoice;
  // A name one of your personal agents has.
  takenElsewhere: (name: string) => boolean;
  adding: boolean;
  onAdd: (agent: NewAgent) => void;
  onCancel: () => void;
}) {
  const tools = ["claude", "codex"] as const;
  const looking = !props.detectionFailed && tools.some((tool) => props.toolState(tool) === null);
  // The sheet shows no choice while dohc looks for the tools. Then it starts
  // on the first tool that is ready, and only the person changes it.
  const [initial, setInitial] = useState<RunsWith | null>(null);
  const start = initial ?? (looking ? null : tools.find((tool) => props.toolState(tool)?.status === "ready") ?? "mcp");
  if (initial === null && start !== null) setInitial(start);
  const [picked, setPicked] = useState<RunsWith | null>(null);
  const choice = picked ?? start;
  // The name follows the choice until the person types one.
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? newAgentName(props.agents, baseName(choice ?? "mcp"), props.takenElsewhere);
  const [hue, setHue] = useState<AgentHue>(props.hue);
  const [enabled, setEnabled] = useState(true);
  const [shownError, setShownError] = useState(false);
  const problem = nameProblem(props.agents, name, props.takenElsewhere);
  const error = problem === "Another agent has this name." || shownError ? problem : null;
  const handle = problem ? "" : agentHandle(name.trim());
  const config = choice === "mcp" ? props.mcpConfig(props.mcpAgentId) : null;
  const state = choice === "mcp" || choice === "link" || choice === null ? null : props.toolState(choice);
  const link = props.agentLink;
  const canAdd = !props.adding && problem === null && (choice === "mcp" || state?.status === "ready");

  const submit = () => {
    // Agent link has no name to check and nothing to add.
    if (choice === "link") return;
    if (problem) {
      setShownError(true);
      return;
    }
    if (!canAdd) return;
    const trimmed = preferredNameFromInput(name)!;
    if (choice === "mcp") {
      props.onAdd({ name: trimmed, hue, enabled: false, idBase: "agent" });
    } else if (choice !== null && state?.status === "ready") {
      props.onAdd({ name: trimmed, hue, enabled, launch: { tool: choice, executable: state.executable }, idBase: choice });
    }
  };

  const option = (id: RunsWith, title: string, line: ReactNode, disabled: boolean, hint?: string) => (
    <button
      key={id}
      type="button"
      role="radio"
      aria-checked={choice === id}
      data-testid={`agent-runs-with-${id}`}
      disabled={disabled}
      title={hint}
      onClick={() => setPicked(id)}
      className={`flex min-h-[52px] min-w-0 flex-col justify-center rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-default ${
        choice === id ? "border-ink bg-hover" : "border-line bg-bg hover:bg-hover disabled:hover:bg-bg"
      }`}
    >
      <span className={`block truncate text-[13px] font-medium ${disabled ? "text-muted" : "text-ink"}`}>{title}</span>
      <span className="text-[12px]">{line}</span>
    </button>
  );

  return (
    <Overlay onClose={props.adding ? undefined : props.onCancel}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-add-title"
        data-testid="agent-add-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="dohc-elevated dohc-pop-in flex w-[min(520px,calc(100vw-32px))] flex-col gap-4 rounded-xl border border-line bg-panel p-5"
      >
        <h2 id="agent-add-title" className="m-0 text-base font-semibold text-ink">Add agent</h2>
        {choice === "link" ? (
          // The sign-in page names the agent, so a name typed here would belong to nobody.
          <div data-testid="agent-add-link-name" className="flex items-center gap-3">
            <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-line text-subtle">
              <Link size={16} />
            </span>
            <p className="m-0 min-w-0 text-[13px] text-muted">You name it when it signs in.</p>
          </div>
        ) : <>
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-add-name" className="text-[12px] text-muted">Name</label>
            <input
              id="agent-add-name"
              data-testid="agent-add-name"
              autoFocus
              value={name}
              maxLength={MAX_PREFERRED_NAME_LENGTH}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby="agent-add-name-note"
              onChange={(event) => {
                setTyped(event.currentTarget.value);
                setShownError(false);
              }}
              className={`h-8 rounded-md border bg-bg px-2.5 text-[13px] text-ink ${error ? "border-danger" : "border-line focus:border-ink"}`}
            />
            <p id="agent-add-name-note" role={error ? "alert" : undefined} className={`m-0 flex min-h-4 items-center gap-1 text-[12px] ${error ? "text-danger" : "text-muted"}`}>
              {error ? <><CircleAlert size={12} aria-hidden />{error}</> : handle ? <>People mention it as <span className="font-mono text-ink">@{handle}</span></> : null}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">Color</span>
            <HueControl label="Agent color" shape="agent" value={hue} onChange={setHue} />
          </div>
        </>}
        <div className="flex flex-col gap-1.5">
          <span id="agent-add-runs-with" className="text-[12px] text-muted">Runs with</span>
          <div role="radiogroup" aria-labelledby="agent-add-runs-with" className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1">
            {tools.map((tool) => {
              const toolName = baseName(tool);
              const found = props.toolState(tool);
              return option(
                tool,
                toolName,
                found ? (
                  <ToolReadiness tone={TILE_STATE[found.status].tone} className="mt-0.5">{TILE_STATE[found.status].text}</ToolReadiness>
                ) : props.detectionFailed ? (
                  <span className="text-muted">Couldn't check</span>
                ) : (
                  <span className="flex text-muted"><LoaderCircle size={12} aria-label={`Looking for ${toolName}`} className="animate-spin" /></span>
                ),
                found?.status !== "ready",
                found?.status === "update" ? `Update ${toolName} to use it here.` : undefined,
              );
            })}
            {option("mcp", "Another agent", <span className="inline-flex items-center gap-1 text-muted"><Plug size={12} aria-hidden />Through MCP</span>, false,
              "Cursor, OpenCode or any agent with MCP")}
            {option(
              "link",
              "Agent link",
              link.status === "ready" ? (
                <span className="flex min-w-0 items-center gap-1 text-muted"><Link size={12} aria-hidden className="shrink-0" /><span className="truncate">{link.host}</span></span>
              ) : link.status === "loading" ? (
                <span className="flex text-muted"><LoaderCircle size={12} aria-label="Looking for your server account" className="animate-spin" /></span>
              ) : (
                <span className="text-muted">{link.status === "failed" ? "Couldn't check" : "Not signed in to a server"}</span>
              ),
              link.status !== "ready",
              link.status === "no-server" ? "Sign in to a server to give an agent a link." : undefined,
            )}
          </div>
        </div>
        {choice === "link" && link.status === "ready" ? <>
          <div data-testid="agent-add-link" className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2">
            {link.link !== null
              ? <Link size={14} aria-hidden className="shrink-0 text-muted" />
              : <CloudOff size={14} aria-hidden className="shrink-0 text-muted" />}
            <span className="min-w-0 truncate text-[13px] text-ink">{link.workspaceName}</span>
            <span className="ml-auto min-w-0 truncate text-[12px] text-muted">{link.link !== null ? link.host : "Not synced"}</span>
            <AgentLinkAppMenu link={link.link} server="dohc-personal" testId="agent-add-link-apps" />
          </div>
          {/* Why the link can't be copied takes the place of what copying it does. */}
          <p data-testid="agent-add-link-note" className="m-0 -mt-2 text-[12px] text-muted">
            {link.link !== null
              ? "The agent signs in in your browser, where you choose what it can reach."
              : `Sync this workspace to ${link.host} to give an agent a link.`}
          </p>
        </> : choice === "mcp" ? (
          <div data-testid="agent-add-connect" className="rounded-lg border border-line bg-bg">
            <div className="flex min-h-11 items-center gap-3 border-b border-line px-3 py-2">
              <span className="text-[13px] text-ink">Paste this into your agent's MCP settings</span>
              <span className="ml-auto">
                <CopyButton label="Copy MCP config" size="button" testId="agent-add-config-copy" disabled={config === null} getText={() => config} />
              </span>
            </div>
            {config !== null ? (
              <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink">{config}</pre>
            ) : props.mcpUnavailable ? (
              <p className="m-0 px-3 py-2.5 text-[12px] text-danger">{props.mcpUnavailable}</p>
            ) : null}
          </div>
        ) : choice !== null && choice !== "link" ? (
          <div className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2">
            <span id="agent-add-run-label" className="text-[13px] text-ink">Run on this computer</span>
            <span className="ml-auto">
              <SwitchControl label="Run on this computer" labelledBy="agent-add-run-label" checked={enabled} onChange={setEnabled} />
            </span>
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          <SecondaryButton type="button" disabled={props.adding} onClick={props.onCancel}>Cancel</SecondaryButton>
          {choice === "link" ? (
            // Nothing is added until the agent signs in, so the copy is the primary.
            <CopyButton
              primary
              label="Copy agent link"
              testId="agent-add-link-copy"
              disabled={link.status !== "ready" || link.link === null}
              getText={() => (link.status === "ready" ? link.link : null)}
            />
          ) : (
            <PrimaryButton type="submit" data-testid="agent-add-confirm" disabled={props.adding || choice === null || (choice !== "mcp" && state?.status !== "ready")}>
              {props.adding ? "Adding…" : "Add agent"}
            </PrimaryButton>
          )}
        </div>
      </form>
    </Overlay>
  );
}
