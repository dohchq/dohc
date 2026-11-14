import { ExternalLink, Reply } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { AgentThreadLine } from "../../ipc/bridgeContract";
import { withErrorWords } from "../../ipc/errorWords";
import {
  forwardingAgents,
  type AgentWithThread,
  type DesktopUserSettings,
} from "../../settings/userSettings";
import { bridge } from "../bridge";
import { createAgentThreadLinesStore, type AgentThreadLinesStore } from "../shell/agentThreadLines";
import type { ReportShellFailure } from "../shell/useShellError";
import { formatRunDuration } from "../time";
import { SecondaryButton } from "../ui/controls";
import { agentChatIdentity } from "./agentChat";
import { AgentThreadAnswerDialog } from "./AgentThreadAnswerDialog";
import { ChatAvatar, useAgentInk } from "./ChatAvatar";
import { WorkingDots } from "./ChatThreadPanel";

// The tool an agent's thread is in, as the person knows it.
const TOOL_NAMES: Record<AgentWithThread["thread"]["tool"], string> = { "t3-code": "T3 Code" };

/** What an agent's thread is doing with the last message forwarded from this chat. */
export function agentThreadLineWords(state: AgentThreadLine["state"], tool: string): string {
  switch (state) {
    case "in-line":
      return `In line in ${tool}`;
    case "working":
      return "Working";
    case "waiting-in-tool":
      return `Waiting for you in ${tool}`;
    case "silent":
      return "Finished without replying here";
  }
}

type Shown = {
  workspaceId: string;
  store: AgentThreadLinesStore;
  // The agents dohc forwards this workspace's messages to, in Settings' order.
  agents: readonly AgentWithThread[];
  open: (agent: AgentWithThread) => void;
};

const AgentThreadLinesContext = createContext<Shown | null>(null);

const listenToNothing = () => undefined;

// Holds one workspace's lines for every chat the shell shows, so a workspace
// reads them once however many chats are open. A workspace with no agent that
// has a thread reads nothing and listens to nothing.
export function AgentThreadLinesProvider(props: {
  workspaceId: string;
  ready: boolean;
  settings: DesktopUserSettings | null;
  report: ReportShellFailure;
  // Takes back a failure's notice once what it named has worked.
  clear: (identity: string) => void;
  children: ReactNode;
}) {
  const { workspaceId, ready, settings } = props;
  const report = useRef(props.report);
  report.current = props.report;
  const clear = useRef(props.clear);
  clear.current = props.clear;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;

  const agents = useMemo(
    () => (settings ? forwardingAgents(settings, workspaceId) : []),
    [settings, workspaceId],
  );
  const forwards = ready && agents.length > 0;
  const store = useMemo(
    () =>
      forwards
        ? createAgentThreadLinesStore(workspaceId, (cause, retry) =>
            report.current({
              message: withErrorWords(
                "dohc could not read what your agents' threads are doing.",
                cause,
              ),
              cause,
              retry,
              identity: `agent-thread-lines:${workspaceId}`,
            }),
          )
        : null,
    [forwards, workspaceId],
  );
  // The lines are here before a chat opens, so its foot does not shift.
  useEffect(() => store?.subscribe(listenToNothing), [store]);

  // An answer that comes after the window left the workspace reports nothing
  // there. Main refuses a Try again from another workspace in its own words.
  const open = useCallback(
    (agent: AgentWithThread) => {
      const identity = `agent-thread-open:${workspaceId}:${agent.id}`;
      const isCurrent = () => currentWorkspace.current === workspaceId;
      const tryOpen = () => {
        if (!isCurrent()) return;
        void bridge()
          .openAgentThread({ workspaceId, agentId: agent.id })
          .then(
            () => {
              if (isCurrent()) clear.current(identity);
            },
            (cause: unknown) => {
              if (!isCurrent()) return;
              report.current({
                message: withErrorWords(
                  `dohc could not open ${agent.name}'s thread in ${TOOL_NAMES[agent.thread.tool]}.`,
                  cause,
                ),
                cause,
                retry: tryOpen,
                identity,
              });
            },
          );
      };
      tryOpen();
    },
    [workspaceId],
  );

  const shown = useMemo<Shown | null>(
    () => (store ? { workspaceId, store, agents, open } : null),
    [agents, open, store, workspaceId],
  );
  return (
    <AgentThreadLinesContext.Provider value={shown}>
      {props.children}
    </AgentThreadLinesContext.Provider>
  );
}

// At the foot of a chat, over its composer: one line for each agent whose
// thread holds a message forwarded from the chat threads on screen. A chat
// that shows several chat threads, as an agent's own chat shows its earlier
// posts, shows each agent's newest state.
export function AgentThreadLines(props: {
  workspaceId: string;
  chatThreadIds: readonly (string | null)[];
  className?: string;
}) {
  const shown = useContext(AgentThreadLinesContext);
  if (!shown || shown.workspaceId !== props.workspaceId) return null;
  // A window that changes workspaces starts over, which closes an open question.
  return (
    <Lines
      key={shown.workspaceId}
      shown={shown}
      chatThreadIds={props.chatThreadIds}
      className={props.className}
    />
  );
}

function Lines(props: {
  shown: Shown;
  chatThreadIds: readonly (string | null)[];
  className?: string | undefined;
}) {
  const { shown, chatThreadIds } = props;
  const all = useSyncExternalStore(shown.store.subscribe, shown.store.lines);
  const rows = useMemo(
    () =>
      shown.agents.flatMap((agent) => {
        let newest: AgentThreadLine | undefined;
        for (const line of all) {
          if (line.agentId !== agent.id || !chatThreadIds.includes(line.chatThreadId)) continue;
          if (!newest || line.forwardedAtMs > newest.forwardedAtMs) newest = line;
        }
        return newest ? [{ agent, line: newest }] : [];
      }),
    [all, chatThreadIds, shown.agents],
  );
  // The question the person is answering here. Only its id is held: the
  // dialog reads the question and keeps it and the answer to itself. It stays
  // open when its line goes, so it can say what became of the question.
  const [answering, setAnswering] = useState<{
    agent: AgentWithThread;
    questionId: string;
  } | null>(null);
  return (
    <>
      {rows.length === 0 ? null : (
        <div data-testid="agent-thread-lines" className={`flex flex-col ${props.className ?? ""}`}>
          {rows.map(({ agent, line }) => (
            <Line
              key={agent.id}
              agent={agent}
              line={line}
              onOpen={shown.open}
              onAnswer={(questionId) => setAnswering({ agent, questionId })}
            />
          ))}
        </div>
      )}
      {answering
        ? // On the page's body, as the chat's other dialogs are, so no pane clips it.
          createPortal(
            <AgentThreadAnswerDialog
              workspaceId={shown.workspaceId}
              agentId={answering.agent.id}
              agentName={answering.agent.name}
              tool={TOOL_NAMES[answering.agent.thread.tool]}
              requestId={answering.questionId}
              asked={all.some(
                (line) =>
                  line.agentId === answering.agent.id && line.questionId === answering.questionId,
              )}
              onOpenInTool={() => shown.open(answering.agent)}
              onClose={() => setAnswering(null)}
            />,
            document.body,
          )
        : null}
    </>
  );
}

function Line(props: {
  agent: AgentWithThread;
  line: AgentThreadLine;
  onOpen: (agent: AgentWithThread) => void;
  onAnswer: (questionId: string) => void;
}) {
  const { agent, line } = props;
  // Only a question can be answered here. An approval stays in the tool.
  const questionId = line.state === "waiting-in-tool" ? line.questionId : null;
  const { presentation } = agentChatIdentity({ agentId: agent.id, name: agent.name }, [agent]);
  const ink = useAgentInk(presentation);
  const tool = TOOL_NAMES[agent.thread.tool];
  return (
    <div
      data-testid="agent-thread-line"
      data-agent-id={agent.id}
      data-state={line.state}
      className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted"
    >
      <span className="flex min-w-0 items-center gap-2">
        <ChatAvatar presentation={presentation} name={agent.name} kind="agent" size="strip" />
        {/* The time sits outside the status, so a screen reader hears each state once.
            Narrow, the state's words give way before the agent's name. */}
        <span role="status" className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 truncate font-semibold ${ink}`}>{agent.name}</span>
          <span className="min-w-12 shrink-[100] truncate">
            {agentThreadLineWords(line.state, tool)}
          </span>
        </span>
        {line.state === "working" ? <WorkingDots presentation={presentation} /> : null}
        <Elapsed key={line.sinceMs} sinceMs={line.sinceMs} />
      </span>
      {questionId === null ? null : (
        <SecondaryButton
          size="row"
          data-testid="agent-thread-answer"
          onClick={() => props.onAnswer(questionId)}
        >
          <Reply size={12} aria-hidden />
          Answer here
        </SecondaryButton>
      )}
      <SecondaryButton
        size="row"
        data-testid="agent-thread-open"
        onClick={() => props.onOpen(agent)}
      >
        <ExternalLink size={12} aria-hidden />
        {`Open in ${tool}`}
      </SecondaryButton>
    </div>
  );
}

const HOUR_MS = 3_600_000;

// How long a state has lasted. Only this repaints as the time passes, once
// for each change of its words: each second in the first hour, then each
// minute. It keeps no timer while it is off screen or the window is hidden.
function Elapsed(props: { sinceMs: number }) {
  const { sinceMs } = props;
  const node = useRef<HTMLSpanElement | null>(null);
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    let timer = 0;
    let onScreen = true;
    const schedule = () => {
      window.clearTimeout(timer);
      if (!onScreen || document.visibilityState === "hidden") return;
      const lasted = Math.max(0, Date.now() - sinceMs);
      const step = lasted < HOUR_MS ? 1_000 : 60_000;
      // The words round to the second, so they change half a second before each step.
      timer = window.setTimeout(resume, step - ((lasted + 500) % step));
    };
    const resume = () => {
      setNowMs(Date.now());
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", resume);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            const seen = entries.at(-1)?.isIntersecting;
            if (seen === undefined || seen === onScreen) return;
            onScreen = seen;
            resume();
          });
    if (node.current) observer?.observe(node.current);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      observer?.disconnect();
    };
  }, [sinceMs]);
  return (
    <span
      ref={node}
      data-testid="agent-thread-line-elapsed"
      className="shrink-0 text-[12px] tabular-nums text-subtle"
    >
      {formatRunDuration(Math.max(0, nowMs - sinceMs))}
    </span>
  );
}
