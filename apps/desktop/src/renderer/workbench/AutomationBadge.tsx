import { useId, useState, type KeyboardEvent } from "react";
import { Zap } from "lucide-react";

type AutomationAuthor = {
  authorDisplayName: string;
  authorOwnerDisplayName?: string;
  authorUserId?: string;
  // Present only when the automation ran on this computer.
  automation?: { automationId: string; collectionPath: string };
};

// Until the Automations panel can open one automation, its Collection's
// automations file is where the automation is defined.
function automationsFile(collectionPath: string): string {
  return `${collectionPath}/automations.yaml`;
}

// Names an automation author beside its name, like AgentBadge does for an
// agent: a screen-reader "automation", and a tooltip with the automation's
// name and the computer it ran on. Only a message this computer's automation
// wrote carries `automation`, so only that one ran on "your computer" and can
// be opened here.
export function AutomationBadge(props: {
  testIdPrefix: string;
  author: AutomationAuthor;
  viewerAuthorId?: string;
  onOpenPath?: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const descriptionId = useId();
  const { author } = props;
  const ranOn = author.automation
    ? "Ran on your computer"
    : author.authorUserId !== undefined && author.authorUserId === props.viewerAuthorId
      ? "Ran on another of your computers"
      : author.authorOwnerDisplayName
        ? `Ran on ${author.authorOwnerDisplayName}'s computer`
        : "Ran on another computer";
  const openPath = author.automation && props.onOpenPath ? automationsFile(author.automation.collectionPath) : undefined;
  const markProps = {
    "data-testid": `${props.testIdPrefix}-automation-badge`,
    "data-chat-escape-local": "true",
    "aria-describedby": open ? descriptionId : undefined,
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    },
  };
  return (
    <span
      className="relative inline-flex text-muted"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onClick={(event) => {
        // The mark sits inside a post or message; its details must not open that too.
        event.stopPropagation();
        setOpen(true);
      }}
    >
      {openPath ? (
        <button
          {...markProps}
          type="button"
          aria-label="Open automation"
          onClick={() => props.onOpenPath?.(openPath)}
          className="inline-flex rounded transition-colors hover:text-ink"
        >
          <Zap size={12} strokeWidth={1.9} aria-hidden />
        </button>
      ) : (
        <span {...markProps} tabIndex={0} aria-label="automation" className="inline-flex rounded">
          <Zap size={12} strokeWidth={1.9} aria-hidden />
          <span className="sr-only">automation</span>
        </span>
      )}
      {open ? (
        <span
          id={descriptionId}
          role="tooltip"
          className="dohc-popover dohc-pop-in absolute left-0 top-full z-50 mt-1 flex w-max max-w-72 flex-col gap-1 rounded-xl border border-line bg-panel p-3 text-[12px] font-normal text-ink"
        >
          <span className="font-medium">{author.authorDisplayName}</span>
          <span className="text-muted">{ranOn}</span>
        </span>
      ) : null}
    </span>
  );
}
