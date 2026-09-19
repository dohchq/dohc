import { useEffect, useRef, useState } from "react";
import { AGENT_TOOLS, supportsAgentProfile, type AgentLaunchProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { useRequestSequence } from "../useRequestSequence";
import { SecondaryButton } from "../ui/controls";

export function AgentToolPicker(props: {
  workspaceId: string;
  profile?: AgentLaunchProfile;
  disabled: boolean;
  checkLabel: "Check" | "Test runner";
  onChange(profile: AgentLaunchProfile): void;
  onError(message: string): void;
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
      if (requests.isCurrent(token)) onError.current(ipcErrorMessage(cause, "dohc could not detect agent tools. Try again."));
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
          className={`min-w-0 rounded-lg border p-3 text-left transition-colors ${selected ? "border-accent bg-bg" : "border-line bg-panel hover:bg-panel-2"} disabled:cursor-default`}>
          <span className="block text-[13px] font-medium text-ink">{tool.name}</span>
          <span className="block text-[11px] text-muted">{loading ? "Detecting…" : !result ? "Not checked" : detected?.probe === "detected" ? `Detected · ${detected.version}` : detected?.executable ? "Version probe failed" : "Not found"}</span>
          <span className="block text-[11px] text-muted">{detected?.auth === "signed-in" ? "Signed in" : detected?.auth === "signed-out" ? "Signed out" : detected?.auth === "credentials-found" ? "Credentials found · sign-in unknown" : "Sign-in unknown"}</span>
          {detected?.executable ? <span className="mt-1 block break-all font-mono text-[11px] text-muted">{detected.executable}</span> : null}
          {!supported ? <span className="mt-1 block text-[11px] text-muted">No launch profile yet</span> : null}
          {tool.id === "claude" && detected?.probe === "detected" && !compatible ? <span className="mt-1 block text-[11px] text-muted">Update Claude Code to 2.1.259 or later to use this profile.</span> : null}
        </button>;
      })}
    </div>
    {props.profile ? <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] text-muted">
      <dt>Executable</dt><dd className="m-0 break-all font-mono">{props.profile.executable}</dd>
      <dt>Working directory</dt><dd className="m-0 break-all font-mono">{result?.workingDirectory ?? "Current workspace"}</dd>
      <dt>Permissions</dt><dd className="m-0">{AGENT_TOOLS.find((tool) => tool.id === props.profile?.tool)?.permissions}</dd>
      <dt>Prompt</dt><dd className="m-0">Conversation through stdin</dd>
      <dt>MCP</dt><dd className="m-0">Tool configuration only. dohc adds no servers.</dd>
    </dl> : null}
    <p className="m-0 text-[11px] text-muted">Detection does not test replies. Use {props.checkLabel} to test a reply through dohc.</p>
  </div>;
}
