import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, CircleAlert } from "lucide-react";
import { AGENT_TOOLS, launchCommand, launchProfile, type AgentToolsResult } from "../../agents/agentToolCatalog";
import type { Agent, AgentSettings } from "../../settings/userSettings";
import { isComposingKey } from "../ui/keys";
import { HueControl } from "./SettingRow";

const LINK = "rounded text-[12px] text-ink underline underline-offset-2 hover:text-muted";
const MIN_TIMEOUT = 1;
const MAX_TIMEOUT = 1440;

function validMinutes(value: string): boolean {
  const minutes = Number(value);
  return value.trim() !== "" && Number.isInteger(minutes) && minutes >= MIN_TIMEOUT && minutes <= MAX_TIMEOUT;
}

/** The tool as detection found it, such as "Codex 0.98, signed in". */
export function toolLine(tool: "claude" | "codex", detection: AgentToolsResult | null): string {
  const name = AGENT_TOOLS.find((entry) => entry.id === tool)!.name;
  const found = detection?.tools.find((entry) => entry.tool === tool);
  if (!found) return name;
  if (found.probe === "not-found") return `${name}, not found`;
  const auth = found.auth === "signed-in" ? ", signed in" : found.auth === "signed-out" ? ", signed out" : "";
  return `${name}${found.version ? ` ${found.version}` : ""}${auth}`;
}

// One value edited in place: Enter or leaving the field saves, Escape keeps it as it was.
// A value it can't save keeps the field open, with the reason beside it.
function InlineField(props: {
  label: string;
  initial: string;
  className: string;
  numeric?: boolean;
  // Why a value can't be saved, or null when it can.
  problem?: (value: string) => string | null;
  // Shown right after the field, such as its unit.
  after?: ReactNode;
  onCommit: (value: string) => void;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(props.initial);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const cancelled = useRef(false);
  useEffect(() => input.current?.select(), []);
  return <>
    <input
      ref={input}
      aria-label={props.label}
      aria-invalid={error ? true : undefined}
      data-unsaved={error ? true : undefined}
      data-edit-in-place
      aria-describedby={error ? errorId : undefined}
      value={draft}
      spellCheck={false}
      autoComplete="off"
      autoCapitalize="none"
      {...(props.numeric ? { type: "number", inputMode: "numeric" as const, min: MIN_TIMEOUT, max: MAX_TIMEOUT, step: 1 } : { maxLength: 4096 })}
      onChange={(event) => {
        setDraft(event.currentTarget.value);
        setError(null);
      }}
      onBlur={() => {
        const found = cancelled.current ? null : (props.problem?.(draft) ?? null);
        setError(found);
        if (found) return;
        if (!cancelled.current) props.onCommit(draft);
        props.onDone();
      }}
      onKeyDown={(event) => {
        if (isComposingKey(event)) return;
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      className={`h-7 rounded-md border bg-bg px-2 text-[12px] text-ink ${error ? "border-danger" : "border-line focus:border-ink"} ${props.className}`}
    />
    {props.after}
    {error ? (
      <span id={errorId} role="alert" className="flex min-w-0 items-center gap-1 text-[12px] text-danger">
        <CircleAlert size={12} aria-hidden className="shrink-0" />{error}
      </span>
    ) : null}
  </>;
}

function Term(props: { label: string; children: ReactNode }) {
  return <>
    <dt className="text-subtle">{props.label}</dt>
    <dd className="m-0 flex min-h-7 min-w-0 items-center gap-2 text-ink">{props.children}</dd>
  </>;
}

/**
 * An agent's details under its row: its color, how dohc starts it, and how
 * long a run may take. Each change saves at once.
 */
export function AgentDetails(props: {
  agent: Agent;
  tools: AgentToolsResult | null;
  onChange: (change: (agent: AgentSettings) => AgentSettings) => void;
  onClose: () => void;
}) {
  const { agent, onChange } = props;
  const [editing, setEditing] = useState<"timeout" | "command" | null>(null);
  const profile = agent.launch ? launchProfile(agent.launch) : undefined;
  const command = agent.launch && "command" in agent.launch ? agent.launch.command : null;
  const id = `agent-details-${agent.id}`;
  const saveCommand = (value: string) => {
    const next = value.trim();
    if (next && next !== (agent.launch ? launchCommand(agent.launch) : "")) {
      onChange((current) => ({ ...current, launch: { command: next } }));
    }
  };
  return (
    <div data-testid="agent-details" className="pb-4 pl-10">
      <button
        type="button"
        aria-expanded
        aria-controls={id}
        onClick={props.onClose}
        className="-ml-1 mb-2.5 flex items-center gap-1 rounded px-1 text-[12px] text-muted hover:text-ink"
      >
        <ChevronDown size={14} aria-hidden />Details
      </button>
      <dl id={id} className="m-0 grid grid-cols-[104px_minmax(0,1fr)] items-center gap-y-1.5 text-[12px]">
        <Term label="Color">
          <HueControl label={`Color of ${agent.name}`} shape="agent" value={agent.hue}
            onChange={(hue) => onChange((current) => ({ ...current, hue }))} />
        </Term>
        {profile ? <>
          <Term label="Tool">{toolLine(profile.tool, props.tools)}</Term>
          <Term label="Program"><span className="min-w-0 break-all">{profile.executable}</span></Term>
        </> : null}
        {agent.launch ? (
          <Term label="Stops after">
            {editing === "timeout" ? <>
              <InlineField label={`Minutes before ${agent.name} stops`} initial={String(agent.timeoutMinutes)} numeric className="w-16 text-right"
                after={<span className="text-muted">min</span>}
                problem={(value) => validMinutes(value) ? null : `Enter whole minutes from ${MIN_TIMEOUT} to ${MAX_TIMEOUT}.`}
                onDone={() => setEditing(null)}
                onCommit={(value) => {
                  const minutes = Number(value);
                  if (minutes !== agent.timeoutMinutes) onChange((current) => ({ ...current, timeoutMinutes: minutes }));
                }} />
            </> : <>
              <span>{agent.timeoutMinutes} min</span>
              <button type="button" className={LINK} aria-label={`Change when ${agent.name} stops`} onClick={() => setEditing("timeout")}>Change</button>
            </>}
          </Term>
        ) : null}
        <Term label="Command">
          {editing === "command" ? (
            <InlineField label={`Command that starts ${agent.name}`} initial={agent.launch ? launchCommand(agent.launch) : ""} className="w-full font-mono"
              onDone={() => setEditing(null)} onCommit={saveCommand} />
          ) : command !== null ? <>
            <code className="min-w-0 truncate font-mono" title={command}>{command}</code>
            <button type="button" className={LINK} aria-label={`Change the command that starts ${agent.name}`} onClick={() => setEditing("command")}>Change</button>
          </> : (
            <button type="button" className={LINK} onClick={() => setEditing("command")}>Use your own command</button>
          )}
        </Term>
      </dl>
    </div>
  );
}
