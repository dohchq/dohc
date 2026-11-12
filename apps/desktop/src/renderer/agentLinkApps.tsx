import { useContext, useLayoutEffect, useRef, useState } from "react";
import { ShellErrorReporter } from "./shell/useShellError";
import { COPY_WORDS, createCopy, type CopyFeedback, type CopySecret } from "./ui/CopyButton";
import { Menu } from "./ui/Menu";

/** The name an agent's program files the link under: dohc's own name for that MCP server. */
export type AgentLinkServer = "dohc-personal" | "dohc-share";

// A link made only of these needs no quoting in sh, PowerShell or cmd, so a
// command that holds it runs as pasted. Any other link gets no command.
const PASTES_AS_TYPED = /^[A-Za-z0-9:/._-]+$/u;

type AgentLinkApp = { id: string; label: string; text: (link: string, server: AgentLinkServer) => string | null };

// What each agent needs in place of the bare link: Grok Bot adds an MCP
// server it is told about in a message, and the two CLIs add one by command.
const APPS: readonly AgentLinkApp[] = [
  { id: "grok-bot", label: "Message for Grok Bot", text: (link) => `Add the MCP server ${link} and connect it.` },
  {
    id: "claude-code",
    label: "Commands for Claude Code",
    text: (link, server) =>
      PASTES_AS_TYPED.test(link) ? `claude mcp add --transport http ${server} ${link}\nclaude mcp login ${server}` : null,
  },
  {
    id: "codex",
    label: "Commands for Codex",
    text: (link, server) =>
      PASTES_AS_TYPED.test(link) ? `codex mcp add ${server} --url ${link}\ncodex mcp login ${server}` : null,
  },
];

/** What the menu copies for each agent it can serve with this link. */
export function agentLinkSetups(link: string, server: AgentLinkServer): { id: string; label: string; text: string }[] {
  return APPS.flatMap((app) => {
    const text = app.text(link, server);
    return text === null ? [] : [{ id: app.id, label: app.label, text }];
  });
}

/**
 * Beside a control that copies an agent's link: the same link as the message
 * or commands a named agent takes. A row answers in place, then the menu
 * closes. `link` is null while there is no link to give.
 */
export function AgentLinkAppMenu(props: {
  link: string | null;
  server: AgentLinkServer;
  // Marks a link that holds a secret, as its copy control does.
  sensitive?: CopySecret | undefined;
  testId: string;
}) {
  const report = useContext(ShellErrorReporter);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState<{ id: string; feedback: CopyFeedback } | null>(null);
  const setups = props.link === null ? [] : agentLinkSetups(props.link, props.server);
  // The row picked last. Its text is made from the link the menu has at the
  // copy, so Try again after a failed copy never gives a link since replaced.
  const picked = useRef<string | null>(null);
  const current = useRef(setups);
  current.current = setups;
  // Whether the open list is showing a row's answer.
  const answered = useRef(false);
  const reportTo = useRef(report);
  reportTo.current = report;
  const secret = useRef(props.sensitive);
  secret.current = props.sensitive;
  const action = useRef<ReturnType<typeof createCopy> | null>(null);
  useLayoutEffect(() => {
    const copy = createCopy({
      getText: () => current.current.find((setup) => setup.id === picked.current)?.text ?? null,
      report: () => reportTo.current,
      secret: () => secret.current,
      show: (feedback) => {
        const id = picked.current;
        if (feedback && id) {
          answered.current = true;
          setAnswer({ id, feedback });
          return;
        }
        // The answer has shown. A list closed since has already let go of it.
        if (!answered.current) return;
        answered.current = false;
        setAnswer(null);
        setOpen(false);
      },
    });
    action.current = copy;
    return () => {
      copy.dispose();
      picked.current = null;
    };
  }, []);

  return (
    <Menu
      label="Copy setup for an agent"
      testId={props.testId}
      menuTestId={`${props.testId}-menu`}
      disabled={props.link === null}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) return;
        answered.current = false;
        setAnswer(null);
      }}
      closeOnPick={false}
      // Its dialogs keep the transform their entrance ends on, which would move a fixed list.
      topLayer
      width={208}
      items={setups.map((setup) => ({
        id: setup.id,
        label: answer?.id === setup.id ? COPY_WORDS[answer.feedback] : setup.label,
        testId: `${props.testId}-${setup.id}`,
        onSelect: () => {
          picked.current = setup.id;
          void action.current?.copy();
        },
      }))}
    >
      {/* Mounted with the list and empty until a row answers, so a screen reader hears the answer. */}
      <span role="status" aria-live="polite" className="sr-only">
        {answer ? COPY_WORDS[answer.feedback] : ""}
      </span>
    </Menu>
  );
}
