import { Check } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { AGENT_TOOLS, CLAUDE_MIN_VERSION, supportsAgentProfile, type AgentLaunchProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useRequestSequence } from "../useRequestSequence";
import { SecondaryButton } from "../ui/controls";
import { pathPieces } from "../ui/PathLine";
import { ToolReadiness } from "./ToolReadiness";

// A whole path that wraps only between folders. Each folder is one box, so a
// space or hyphen inside it is no break; it wraps inside only when wider than the line.
function WrappedPath(props: { path: string }) {
  return <>{pathPieces(props.path).map((piece, index) => <Fragment key={index}><span className="inline-block max-w-full">{piece}</span><wbr /></Fragment>)}</>;
}

const DETAILS = "m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted";

// A tool card says what a person picks by: the tool, its version, and
// whether it is signed in. Under the cards the chosen tool's permissions stay
// in view; how it starts (its executable, folder, prompt and MCP) waits under
// Advanced with the runner command.
export function AgentToolPicker(props: {
  workspaceId: string;
  profile?: AgentLaunchProfile;
  // A runner command is set and no tool is chosen, so the agent runs that.
  usingCommand?: boolean;
  disabled: boolean;
  advancedOpen: boolean;
  onAdvancedToggle(open: boolean): void;
  // The rest of Advanced, after the chosen tool's details.
  children?: ReactNode;
  onChange(profile: AgentLaunchProfile): void;
  onError(message: string, cause?: unknown): void;
}) {
  const [result, setResult] = useState<AgentToolsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const requests = useRequestSequence([props.workspaceId]);
  const onError = useRef(props.onError);
  onError.current = props.onError;
  useEffect(() => {
    const token = requests.next();
    setResult(null);
    setLoading(true);
    void bridge().detectAgentTools({ workspaceId: props.workspaceId }).then((value) => {
      if (requests.isCurrent(token)) setResult(value);
    }).catch((cause: unknown) => {
      if (requests.isCurrent(token)) onError.current(ipcErrorMessage(cause, "dohc could not detect agent tools. Try again."), cause);
    }).finally(() => {
      if (requests.isCurrent(token)) setLoading(false);
    });
    return () => { requests.next(); };
  }, [props.workspaceId, refresh, requests]);

  return <div className="flex flex-col gap-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted">{loading ? "Looking for installed tools…" : "Choose an installed tool"}</span>
      <SecondaryButton size="compact" disabled={loading || props.disabled} onClick={() => setRefresh((value) => value + 1)}>Refresh</SecondaryButton>
    </div>
    <div className="grid grid-cols-2 gap-2 max-[480px]:grid-cols-1">
      {AGENT_TOOLS.map((tool) => {
        const detected = result?.tools.find((value) => value.tool === tool.id);
        const supported = tool.id === "claude" || tool.id === "codex";
        const selected = props.profile?.tool === tool.id;
        const compatible = supportsAgentProfile(tool.id, detected?.version ?? null);
        const selectable = compatible && detected?.probe === "detected" && detected.executable;
        return <button key={tool.id} type="button" aria-label={tool.name} aria-pressed={selected}
          disabled={props.disabled || !selectable}
          onClick={() => {
            if (detected?.executable && (tool.id === "claude" || tool.id === "codex")) props.onChange({ tool: tool.id, executable: detected.executable });
          }}
          className={`min-w-0 rounded-lg border p-3 text-left transition-colors ${selected ? "border-accent bg-selected ring-1 ring-accent" : "border-line bg-panel enabled:hover:bg-hover"} disabled:cursor-default`}>
          <span className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink">{tool.name}</span>
            {selected ? <Check size={14} aria-hidden className="shrink-0 text-accent" /> : null}
          </span>
          <span className="block text-[11px] text-muted">{loading ? "Detecting…" : !result ? "Not checked" : detected?.probe === "detected" ? `Detected · ${detected.version}` : detected?.executable ? "Version probe failed" : "Not found"}</span>
          <ToolReadiness tone={detected?.auth === "signed-in" ? "ready" : detected?.auth === "signed-out" ? "blocked" : "unknown"} className="text-[11px]">
            {detected?.auth === "signed-in" ? "Signed in" : detected?.auth === "signed-out" ? "Sign in first" : detected?.auth === "credentials-found" ? "Credentials found · sign-in unknown" : "Sign-in unknown"}
          </ToolReadiness>
          {!supported ? <span className="mt-1 block text-[11px] text-muted">No launch profile yet</span> : null}
          {tool.id === "claude" && detected?.probe === "detected" && !compatible ? <span className="mt-1 block text-[11px] text-muted">Update Claude Code to {CLAUDE_MIN_VERSION} or later to use this profile.</span> : null}
        </button>;
      })}
    </div>
    {props.profile ? <dl data-testid="agent-tool-permissions" className={DETAILS}>
      <dt>Permissions</dt><dd className="m-0">{AGENT_TOOLS.find((tool) => tool.id === props.profile?.tool)?.permissions}</dd>
    </dl> : props.usingCommand ? <p data-testid="agent-tool-using-command" className="m-0 text-[11px] text-muted">Using your runner command.</p> : null}
    <p className="m-0 text-[11px] text-muted">Detection does not test replies. Use Check to test a reply through dohc.</p>
    <details open={props.advancedOpen} onToggle={(event) => props.onAdvancedToggle(event.currentTarget.open)} className="mt-2">
      <summary className="cursor-pointer text-[12px] text-muted">Advanced</summary>
      {props.profile ? <dl data-testid="agent-tool-launch" className={`${DETAILS} mt-2`}>
        <dt>Executable</dt><dd className="m-0 min-w-0 select-text wrap-break-word font-mono"><WrappedPath path={props.profile.executable} /></dd>
        <dt>Working directory</dt><dd className="m-0 min-w-0 select-text wrap-break-word font-mono"><WrappedPath path={result?.workingDirectory ?? "Current workspace"} /></dd>
        <dt>Prompt</dt><dd className="m-0">Conversation through stdin</dd>
        <dt>MCP</dt><dd className="m-0">dohc adds its own server for replies.</dd>
      </dl> : null}
      {props.children}
    </details>
  </div>;
}
