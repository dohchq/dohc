import { CircleAlert, CircleCheck, CircleStop, ExternalLink, Hourglass } from "lucide-react";
import type { ChatWorkStatus } from "@dohc/workspace-contracts/chat-work";
import type { ChatMessageRecord, ChatThreadWorkRecord } from "../../ipc/bridgeContract";
import { openLink } from "../linkActivation";
import { formatChatTime } from "../time";

// An agent's work outside dohc, as that agent reported it: where the work
// stands, and a link to it. dohc checks neither, so the tooltip says who
// reported it and when.
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
    case "done": return <CircleCheck size={12} strokeWidth={2} aria-hidden className="text-success" />;
    case "failed": return <CircleAlert size={12} strokeWidth={2} aria-hidden className="text-danger" />;
    case "stopped": return <CircleStop size={12} strokeWidth={2} aria-hidden />;
  }
}

// Where a link leads, as the site's name a person recognizes.
function linkHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// A thread's Work card from its messages, as the engine derives it for the
// thread listing: the newest report gives the status, and the newest report
// with a link gives the link.
export function threadWork(messages: readonly ChatMessageRecord[]): ChatThreadWorkRecord | undefined {
  const newer = (left: ChatMessageRecord, right: ChatMessageRecord) =>
    left.createdAtMs !== right.createdAtMs ? left.createdAtMs > right.createdAtMs : left.id > right.id;
  let newest: ChatMessageRecord | undefined;
  let linked: ChatMessageRecord | undefined;
  for (const message of messages) {
    if (!message.work) continue;
    if (!newest || newer(message, newest)) newest = message;
    if (message.work.url !== undefined && (!linked || newer(message, linked))) linked = message;
  }
  if (!newest?.work) return undefined;
  return {
    status: newest.work.status,
    ...(linked?.work?.url === undefined ? {} : { url: linked.work.url }),
    messageId: newest.id,
    authorDisplayName: newest.authorDisplayName,
    reportedAtMs: newest.createdAtMs,
  };
}

export function WorkStatus(props: {
  testIdPrefix: string;
  work: { status: ChatWorkStatus; url?: string };
  // Who reported it and when. Left out on a message, which already shows both.
  reportedBy?: { name: string; atMs: number };
  // Name the agent beside the status, where the row shows another author.
  showReporter?: boolean;
}) {
  const { work, reportedBy } = props;
  const url = work.url;
  const reported = reportedBy
    ? `Reported by ${reportedBy.name}, ${formatChatTime(reportedBy.atMs).label}`
    : undefined;
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
        ) : reported ? <span className="sr-only">. {reported}</span> : null}
      </span>
      {url !== undefined ? (
        <button
          type="button"
          data-testid={`${props.testIdPrefix}-work-open`}
          title={url}
          aria-label={`Open ${linkHost(url)}`}
          onClick={(event) => {
            event.stopPropagation();
            void openLink(url);
          }}
          className="inline-flex min-w-0 items-center gap-1 rounded text-muted transition-colors duration-75 hover:text-ink"
        >
          <ExternalLink size={12} strokeWidth={2} aria-hidden className="shrink-0" />
          <span className="truncate">{linkHost(url)}</span>
        </button>
      ) : null}
    </span>
  );
}
