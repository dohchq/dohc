import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, CircleAlert, CloudOff, Info, Link, LoaderCircle, Plug } from "lucide-react";
import {
  MAX_PREFERRED_NAME_LENGTH,
  preferredNameFromInput,
} from "@dohc/workspace-contracts/chat-identity-values";
import type { AgentHue } from "@dohc/workspace-contracts/agent-hues";
import type { ActorPresentation } from "../../ipc/bridgeContract";
import { AGENT_TOOLS, type AgentLaunch } from "../../agents/agentToolCatalog";
import {
  agentHandle,
  agentNameTaken,
  newAgentName,
  type AgentThread,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { AgentLinkAppMenu } from "../agentLinkApps";
import { Overlay } from "../Overlay";
import { CopyButton } from "../ui/CopyButton";
import { FieldError, IconButton, PrimaryButton, SecondaryButton } from "../ui/controls";
import { ChatAvatar } from "../workbench/ChatAvatar";
import { HueControl, SwitchControl } from "./SettingRow";
import { T3_CODE, T3CodeChoice, type T3CodeThreadChoice } from "./T3CodeThread";
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

export type RunsWith = "claude" | "codex" | "t3-code" | "mcp" | "link";

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
  // The agent's own thread in its tool. dohc forwards to it and never starts it.
  thread?: AgentThread;
  startThread?: { projectId: string; requestId: string };
  idBase: string;
};

function nameProblem(
  agents: DesktopUserSettings["agents"],
  value: string,
  takenElsewhere: (name: string) => boolean,
): string | null {
  try {
    const name = preferredNameFromInput(value);
    if (!name) return "Enter an agent name.";
    return agentNameTaken(agents, "", name) || takenElsewhere(name)
      ? "Another agent has this name."
      : null;
  } catch {
    return "This name cannot be used.";
  }
}

const baseName = (choice: RunsWith) =>
  AGENT_TOOLS.find((entry) => entry.id === choice)?.name ?? "Agent";

const THREAD_SEARCH_ID = "agent-add-thread-search";

function isPrivateIpv4(a: number, b: number): boolean {
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

export function isPrivateServerHost(host: string): boolean {
  let hostname: string;
  try {
    hostname = (host.includes("://") ? new URL(host).hostname : new URL(`https://${host}`).hostname)
      .toLowerCase()
      .replace(/\.+$/u, "");
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6 = hostname.slice(1, -1);
    if (ipv6 === "::1" || ipv6 === "::") return true;
    if (ipv6.startsWith("64:ff9b::")) return true;
    if (ipv6.startsWith("::ffff:")) {
      const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(ipv6.slice("::ffff:".length));
      if (hex) {
        const hi = Number.parseInt(hex[1]!, 16);
        return isPrivateIpv4((hi >> 8) & 0xff, hi & 0xff);
      }
    }
    const firstHex = /^([0-9a-f]{1,4}):/u.exec(ipv6);
    if (!firstHex) return false;
    const first = Number.parseInt(firstHex[1]!, 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    !hostname.includes(".") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!ipv4) return false;
  return isPrivateIpv4(Number(ipv4[1]), Number(ipv4[2]));
}

export function agentLinkCloudWarning(linkUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(linkUrl);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
  if (isPrivateServerHost(parsed.host)) {
    return "This server uses a local or private address. Cloud apps such as Claude and ChatGPT need a public HTTPS server to connect.";
  }
  if (parsed.protocol !== "https:") {
    return "This link uses HTTP instead of HTTPS. Cloud apps such as Claude and ChatGPT need a public HTTPS server to connect.";
  }
  if (hostname.endsWith(".ts.net")) {
    return "Tailscale addresses need Funnel turned on before cloud apps such as Claude and ChatGPT can connect.";
  }
  return null;
}

const HAS_SETUP: ReadonlySet<RunsWith> = new Set(["t3-code", "mcp", "link"]);
const RUNS_WITH_LINE: Partial<Record<RunsWith, string>> = {
  "t3-code": T3_CODE,
  mcp: "Another agent, through MCP",
};

const presentationFor = (hue: AgentHue): ActorPresentation => ({
  group: "",
  hue: hue === "olive" ? null : hue,
  self: false,
});

export function AddAgentSheet(props: {
  agents: DesktopUserSettings["agents"];
  // Each tool's readiness, or null while dohc looks or when it could not.
  toolState: (tool: "claude" | "codex") => ToolTileState | null;
  detectionFailed: boolean;
  hue: AgentHue;
  mcpConfig: (agentId: string) => string | null;
  mcpUnavailable: string | null;
  // The id an agent you run would get.
  mcpAgentId: string;
  agentLink: AgentLinkChoice;
  // A name one of your personal agents has.
  takenElsewhere: (name: string) => boolean;
  adding: boolean;
  // Why the last Add added nothing, such as a thread T3 Code would not let dohc message.
  addError?: string | null;
  onAdd: (agent: NewAgent) => void;
  onCancel: () => void;
}) {
  const tools = ["claude", "codex"] as const;
  const looking = !props.detectionFailed && tools.some((tool) => props.toolState(tool) === null);
  const readyTool = tools.find((tool) => props.toolState(tool)?.status === "ready");
  const [typed, setTyped] = useState<string | null>(null);
  const [initial, setInitial] = useState<RunsWith | null>(null);
  const start: RunsWith | null =
    initial ??
    (looking
      ? null
      : readyTool !== undefined
        ? readyTool
        : typed !== null
          ? "mcp"
          : props.agentLink.status === "loading"
            ? null
            : props.agentLink.status === "ready" && props.agentLink.link !== null
              ? "link"
              : "mcp");
  if (initial === null && start !== null) setInitial(start);
  const [picked, setPicked] = useState<RunsWith | null>(null);
  const choice = picked ?? start;
  const [setup, setSetup] = useState(false);
  const onSetup = setup && choice !== null && HAS_SETUP.has(choice);
  const formRef = useRef<HTMLFormElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (choice !== "link" || onSetup) return;
    const form = formRef.current;
    if (!form) return;
    const focused = document.activeElement;
    if (focused === null || focused === document.body || !form.contains(focused)) {
      form.querySelector<HTMLElement>('[data-testid="agent-runs-with-link"]')?.focus();
    }
  }, [choice, onSetup]);
  const turned = useRef<"setup" | "choice" | "name" | null>(null);
  useLayoutEffect(() => {
    const to = turned.current;
    turned.current = null;
    const form = formRef.current;
    if (to === null || !form) return;
    if (to === "setup") {
      const first = form.querySelector<HTMLElement>(
        "[data-agent-add-setup] :is(button, input, select):not(:disabled, [tabindex='-1'])",
      );
      (first ?? backRef.current)?.focus();
    } else if (to === "name") {
      document.getElementById("agent-add-name")?.focus();
    } else {
      form.querySelector<HTMLElement>(`[data-testid="agent-runs-with-${choice}"]`)?.focus();
    }
  }, [onSetup, choice]);
  const turn = (to: "setup" | "choice" | "name") => {
    turned.current = to;
    setSetup(to === "setup");
  };
  // The T3 Code thread to connect. Its title is the name until the person types one.
  const [thread, setThread] = useState<T3CodeThreadChoice | null>(null);
  const [newIn, setNewIn] = useState<string | null>(null);
  const [threadMissing, setThreadMissing] = useState(false);
  const [t3CodeReady, setT3CodeReady] = useState(false);
  const pickThread = useCallback((next: T3CodeThreadChoice | null) => {
    setThread(next);
    setNewIn(null);
    setThreadMissing(false);
  }, []);
  const pickNew = useCallback((projectId: string) => {
    setThread(null);
    setNewIn(projectId);
    setThreadMissing(false);
  }, []);
  const startIds = useRef(new Map<string, string>());
  const threadName =
    choice === "t3-code" ? thread?.title.trim().slice(0, MAX_PREFERRED_NAME_LENGTH).trim() : "";
  const name =
    typed ??
    newAgentName(props.agents, threadName || baseName(choice ?? "mcp"), props.takenElsewhere);
  const [hue, setHue] = useState<AgentHue>(props.hue);
  const [enabled, setEnabled] = useState(true);
  const [shownError, setShownError] = useState(false);
  const problem = nameProblem(props.agents, name, props.takenElsewhere);
  const error = problem === "Another agent has this name." || shownError ? problem : null;
  const handle = problem ? "" : agentHandle(name.trim());
  const config = choice === "mcp" ? props.mcpConfig(props.mcpAgentId) : null;
  const tool = choice === "claude" || choice === "codex" ? choice : null;
  const state = tool ? props.toolState(tool) : null;
  const link = props.agentLink;
  const cloudWarning =
    link.status === "ready" && link.link !== null ? agentLinkCloudWarning(link.link) : null;

  const submit = () => {
    if (choice === null) return;
    if (!onSetup && HAS_SETUP.has(choice)) {
      if (choice !== "link" && problem) {
        setShownError(true);
        return;
      }
      turn("setup");
      return;
    }
    if (choice === "link" || props.adding) return;
    if (problem) {
      setShownError(true);
      if (onSetup) turn("name");
      return;
    }
    const trimmed = preferredNameFromInput(name)!;
    if (choice === "t3-code") {
      if (!t3CodeReady) return;
      if (newIn !== null) {
        const key = JSON.stringify([newIn, trimmed]);
        const requestId = startIds.current.get(key) ?? crypto.randomUUID();
        startIds.current.set(key, requestId);
        props.onAdd({
          name: trimmed,
          hue,
          enabled: true,
          startThread: { projectId: newIn, requestId },
          idBase: "t3-code",
        });
        return;
      }
      if (!thread) {
        setThreadMissing(true);
        document.getElementById(THREAD_SEARCH_ID)?.focus();
        return;
      }
      props.onAdd({
        name: trimmed,
        hue,
        enabled: true,
        thread: { tool: "t3-code", id: thread.id },
        idBase: "t3-code",
      });
      return;
    }
    if (choice === "mcp") {
      props.onAdd({ name: trimmed, hue, enabled: false, idBase: "agent" });
    } else if (tool !== null && state?.status === "ready") {
      props.onAdd({
        name: trimmed,
        hue,
        enabled,
        launch: { tool, executable: state.executable },
        idBase: tool,
      });
    }
  };

  const option = (
    id: RunsWith,
    title: string,
    line: ReactNode,
    disabled: boolean,
    hint?: string,
  ) => (
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
        choice === id
          ? "border-ink bg-hover"
          : "border-line bg-bg hover:bg-hover disabled:hover:bg-bg"
      }`}
    >
      <span
        className={`block truncate text-[13px] font-medium ${disabled ? "text-muted" : "text-ink"}`}
      >
        {title}
      </span>
      <span className="text-[12px]">{line}</span>
    </button>
  );

  const choosePage = (
    <>
      {choice === "link" ? (
        <div data-testid="agent-add-link-name" className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-lg border border-dashed border-line text-subtle"
          >
            <Link size={16} />
          </span>
          <p className="m-0 min-w-0 text-[13px] text-muted">You name it when it signs in.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <label htmlFor="agent-add-name" className="text-[12px] text-muted">
              Name
            </label>
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
            <p
              id="agent-add-name-note"
              role={error ? "alert" : undefined}
              className={`m-0 flex min-h-4 items-center gap-1 text-[12px] ${error ? "text-danger" : "text-muted"}`}
            >
              {error ? (
                <>
                  <CircleAlert size={12} aria-hidden />
                  {error}
                </>
              ) : handle ? (
                <>
                  People mention it as <span className="font-mono text-ink">@{handle}</span>
                </>
              ) : null}
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] text-muted">Color</span>
            <HueControl label="Agent color" shape="agent" value={hue} onChange={setHue} />
          </div>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <span id="agent-add-runs-with" className="text-[12px] text-muted">
          Runs with
        </span>
        <div
          role="radiogroup"
          aria-labelledby="agent-add-runs-with"
          className="grid grid-cols-2 gap-2 max-[560px]:grid-cols-1"
        >
          {tools.map((tool) => {
            const toolName = baseName(tool);
            const found = props.toolState(tool);
            return option(
              tool,
              toolName,
              found ? (
                <ToolReadiness tone={TILE_STATE[found.status].tone} className="mt-0.5">
                  {TILE_STATE[found.status].text}
                </ToolReadiness>
              ) : props.detectionFailed ? (
                <span className="text-muted">Could not check</span>
              ) : (
                <span className="flex text-muted">
                  <LoaderCircle
                    size={12}
                    aria-label={`Looking for ${toolName}`}
                    className="animate-spin"
                  />
                </span>
              ),
              found?.status !== "ready",
              found?.status === "update" ? `Update ${toolName} to use it here.` : undefined,
            );
          })}
          {option(
            "t3-code",
            T3_CODE,
            <span className="text-muted">A new or existing thread</span>,
            false,
          )}
          {option(
            "mcp",
            "Another agent",
            <span className="inline-flex items-center gap-1 text-muted">
              <Plug size={12} aria-hidden />
              Through MCP
            </span>,
            false,
            "Claude Desktop, Cursor, or any local MCP app",
          )}
          {option(
            "link",
            "Agent link",
            link.status === "ready" ? (
              <span className="flex min-w-0 items-center gap-1 text-muted">
                <Link size={12} aria-hidden className="shrink-0" />
                <span className="truncate">{link.host}</span>
              </span>
            ) : link.status === "loading" ? (
              <span className="flex text-muted">
                <LoaderCircle
                  size={12}
                  aria-label="Looking for your server account"
                  className="animate-spin"
                />
              </span>
            ) : (
              <span className="text-muted">
                {link.status === "failed" ? "Could not check" : "Not signed in to a server"}
              </span>
            ),
            link.status !== "ready",
            link.status === "no-server"
              ? "Sign in to a server to connect Claude, ChatGPT, OpenClaw, or another agent with a link."
              : link.status === "ready"
                ? "Claude, ChatGPT, OpenClaw, and other MCP apps"
                : undefined,
          )}
        </div>
      </div>
      {tool !== null ? (
        <div className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2">
          <span id="agent-add-run-label" className="text-[13px] text-ink">
            Run on this computer
          </span>
          <span className="ml-auto">
            <SwitchControl
              label="Run on this computer"
              labelledBy="agent-add-run-label"
              checked={enabled}
              onChange={setEnabled}
            />
          </span>
        </div>
      ) : null}
    </>
  );

  const setupPage =
    choice === "link" && link.status === "ready" ? (
      <>
        <div
          data-testid="agent-add-link"
          className="flex min-h-11 items-center gap-3 rounded-lg border border-line bg-bg px-3 py-2"
        >
          {link.link !== null ? (
            <Link size={14} aria-hidden className="shrink-0 text-muted" />
          ) : (
            <CloudOff size={14} aria-hidden className="shrink-0 text-muted" />
          )}
          <span className="min-w-0 truncate text-[13px] text-ink">{link.workspaceName}</span>
          <span className="ml-auto min-w-0 truncate text-[12px] text-muted">
            {link.link !== null ? link.host : "Not synced"}
          </span>
          <AgentLinkAppMenu link={link.link} server="dohc-personal" testId="agent-add-link-apps" />
        </div>
        <p data-testid="agent-add-link-note" className="m-0 -mt-2 text-[12px] text-muted">
          {link.link !== null
            ? "Copy the link and add it as a custom MCP connector in Claude, ChatGPT, OpenClaw, or another MCP app. Your browser opens to name it and choose what it can reach."
            : `Sync this workspace to ${link.host} to give an agent a link.`}
        </p>
        {cloudWarning !== null ? (
          <p
            data-testid="agent-add-link-private-note"
            className="m-0 -mt-1 flex items-start gap-2 rounded-lg bg-panel-2 px-3 py-2 text-[12px] text-muted"
          >
            <Info size={14} aria-hidden className="mt-0.5 shrink-0 text-subtle" />
            <span className="min-w-0">{cloudWarning}</span>
          </p>
        ) : null}
      </>
    ) : choice === "mcp" ? (
      <>
        <div data-testid="agent-add-connect" className="rounded-lg border border-line bg-bg">
          <div className="flex min-h-11 items-center gap-3 border-b border-line px-3 py-2">
            <span className="text-[13px] text-ink">Paste this into your agent's MCP settings</span>
            <span className="ml-auto">
              <CopyButton
                label="Copy MCP config"
                size="button"
                testId="agent-add-config-copy"
                disabled={config === null}
                getText={() => config}
              />
            </span>
          </div>
          {config !== null ? (
            <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11px] leading-relaxed text-ink">
              {config}
            </pre>
          ) : props.mcpUnavailable ? (
            <p className="m-0 px-3 py-2.5 text-[12px] text-danger">{props.mcpUnavailable}</p>
          ) : null}
        </div>
        {config !== null || link.status === "no-server" ? (
          <p data-testid="agent-add-mcp-note" className="m-0 -mt-2 text-[12px] text-muted">
            {[
              config !== null
                ? "For local apps on this computer such as Claude Desktop or Cursor. Save the app's MCP config file, then restart the app."
                : null,
              link.status === "no-server"
                ? "To connect Claude, ChatGPT, or OpenClaw with a link instead, sign in to a server and sync this workspace."
                : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}
      </>
    ) : choice === "t3-code" ? (
      <T3CodeChoice
        picked={thread?.id ?? null}
        onPick={pickThread}
        newThread={{ title: name.trim(), picked: newIn !== null, onPick: pickNew }}
        error={threadMissing ? "Choose a thread." : null}
        searchId={THREAD_SEARCH_ID}
        onReady={setT3CodeReady}
      />
    ) : null;

  return (
    <Overlay onClose={props.adding ? undefined : props.onCancel}>
      <form
        ref={formRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-add-title"
        data-testid="agent-add-sheet"
        data-page={onSetup ? "setup" : "choose"}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="dohc-elevated dohc-pop-in flex max-h-[calc(100vh-32px)] w-[min(520px,calc(100vw-32px))] flex-col gap-4 overflow-hidden rounded-xl border border-line bg-panel p-5"
      >
        <div className="flex shrink-0 items-center gap-2">
          {onSetup ? (
            <IconButton
              ref={backRef}
              data-testid="agent-add-back"
              aria-label="Back"
              title="Back"
              disabled={props.adding}
              onClick={() => turn("choice")}
              className="-ml-1"
            >
              <ChevronLeft size={16} aria-hidden />
            </IconButton>
          ) : null}
          <h2 id="agent-add-title" className="m-0 text-base font-semibold text-ink">
            Add agent
          </h2>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <div hidden={onSetup} className={onSetup ? "hidden" : "flex flex-col gap-4"}>
            {choosePage}
          </div>
          {choice !== null && HAS_SETUP.has(choice) ? (
            <div hidden={!onSetup} className={onSetup ? "flex flex-col gap-4" : "hidden"}>
              {choice !== "link" ? (
                <div data-testid="agent-add-summary" className="flex min-w-0 items-center gap-3">
                  <ChatAvatar
                    name={name}
                    kind="agent"
                    presentation={presentationFor(hue)}
                    size="row"
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      data-testid="agent-add-summary-name"
                      className="block truncate text-[13px] font-medium text-ink"
                    >
                      {name}
                    </span>
                    <span className="block truncate text-[12px] text-muted">
                      {RUNS_WITH_LINE[choice]}
                    </span>
                  </span>
                </div>
              ) : null}
              <div data-agent-add-setup className="flex flex-col gap-4">
                {setupPage}
              </div>
            </div>
          ) : null}
          {props.addError ? (
            <FieldError id="agent-add-error" testId="agent-add-error">
              {props.addError}
            </FieldError>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          <SecondaryButton type="button" disabled={props.adding} onClick={props.onCancel}>
            Cancel
          </SecondaryButton>
          {!onSetup && choice !== null && HAS_SETUP.has(choice) ? (
            <PrimaryButton
              type="submit"
              data-testid="agent-add-next"
              disabled={choice === "link" && link.status !== "ready"}
            >
              Next
            </PrimaryButton>
          ) : choice === "link" ? (
            // Nothing is added until the agent signs in, so the copy is the primary.
            <CopyButton
              primary
              label="Copy agent link"
              testId="agent-add-link-copy"
              disabled={link.status !== "ready" || link.link === null}
              getText={() => (link.status === "ready" ? link.link : null)}
            />
          ) : choice === "t3-code" && !t3CodeReady ? null : (
            // Until dohc is allowed in T3 Code there is no thread to add.
            <PrimaryButton
              type="submit"
              data-testid="agent-add-confirm"
              aria-describedby={props.addError ? "agent-add-error" : undefined}
              disabled={
                props.adding || choice === null || (tool !== null && state?.status !== "ready")
              }
            >
              {props.adding ? "Adding…" : "Add agent"}
            </PrimaryButton>
          )}
        </div>
      </form>
    </Overlay>
  );
}
