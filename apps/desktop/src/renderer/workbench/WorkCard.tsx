import { CircleAlert, CircleCheck, CircleStop, ExternalLink, Hourglass } from "lucide-react";
import type { ChatWorkStatus } from "@dohc/workspace-contracts/chat-work";
import { openLink } from "../linkActivation";
import { formatChatTime } from "../time";

// An agent's work outside dohc, as that agent reported it: where the work
// stands, and a link to it. dohc checks neither, so every mark is the plain
// color, and the tooltip and accessible name say it is reported.
const STATUS_WORD: Record<ChatWorkStatus, string> = {
  working: "Working",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

function StatusMark(props: { status: ChatWorkStatus }) {
  switch (props.status) {
    // A running agent's dot.
    case "working": return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-agent" />;
    case "waiting": return <Hourglass size={12} strokeWidth={2} aria-hidden />;
    case "done": return <CircleCheck size={12} strokeWidth={2} aria-hidden />;
    case "failed": return <CircleAlert size={12} strokeWidth={2} aria-hidden />;
    case "stopped": return <CircleStop size={12} strokeWidth={2} aria-hidden />;
  }
}

// A long host keeps its end, where the site's own name is.
const HOST_MAX_CHARS = 32;

// The site a link leads to, or null for a link that is not a web address.
// The parsed host leaves out any `name@` before it.
export function linkHost(url: string): string | null {
  let host: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    host = parsed.host;
  } catch {
    return null;
  }
  if (host === "") return null;
  return host.length > HOST_MAX_CHARS ? `…${host.slice(1 - HOST_MAX_CHARS)}` : host;
}

export function WorkStatus(props: {
  testIdPrefix: string;
  work: { status: ChatWorkStatus; url?: string };
  // Who reported it and when. Left out on a message, which already shows both.
  reportedBy?: { name: string; owner?: string; atMs: number };
  // Name the agent beside the status, where the row shows another author.
  showReporter?: boolean;
}) {
  const { work, reportedBy } = props;
  const url = work.url;
  const host = url === undefined ? null : linkHost(url);
  const reported = reportedBy
    ? `As reported by ${reportedBy.name}${reportedBy.owner ? `, ${reportedBy.owner}'s agent` : ""}, ${formatChatTime(reportedBy.atMs).label}`
    : "As reported";
  return (
    <span
      data-testid={`${props.testIdPrefix}-work`}
      data-status={work.status}
      className="inline-flex min-w-0 items-center gap-2 text-[12px] text-muted"
    >
      <span title={reported} className="inline-flex shrink-0 items-center gap-1">
        <StatusMark status={work.status} />
        {STATUS_WORD[work.status]}
        {reportedBy && props.showReporter ? (
          <span data-testid={`${props.testIdPrefix}-work-reporter`} className="text-subtle">{reportedBy.name}</span>
        ) : null}
        <span className="sr-only">. {reported}</span>
      </span>
      {url !== undefined && host !== null ? (
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-work-open`}
          title={url}
          aria-label={`Open ${host}, as reported`}
          onClick={(event) => {
            event.stopPropagation();
            void openLink(url);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded text-muted transition-colors duration-75 hover:text-ink"
        >
          <ExternalLink size={12} strokeWidth={2} aria-hidden className="shrink-0" />
          {host}
        </button>
      ) : null}
    </span>
  );
}
