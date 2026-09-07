import { Share2, X } from "lucide-react";
import { useState } from "react";
import { EmailShareForm } from "./EmailShareForm";
import { IconButton } from "./ui/controls";
import { useRelayShareLinkPane } from "./useRelayShareLinkPane";

export type RelayShareTarget =
  | { kind: "paths"; paths: [string, ...string[]]; label?: string }
  | { kind: "version"; versionId: string; versionName?: string };

type ShareWith = "email" | "link";

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
}) {
  const [shareWith, setShareWith] = useState<ShareWith>("email");
  const linkPane = useRelayShareLinkPane({
    workspaceId: props.workspaceId,
    target: props.target,
    visible: shareWith === "link",
    onClose: props.onClose,
  });

  const subject =
    props.target.kind === "version"
      ? `version “${props.target.versionName ?? props.target.versionId}”`
      : (props.target.label ?? props.target.paths[0] ?? "this selection");

  return (
    <div
      data-testid="share-dialog"
      className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        <Share2 size={14} aria-hidden className="text-subtle" />
        <h2 className="m-0 flex-1 text-sm font-semibold text-ink">Share</h2>
        <IconButton aria-label="Close" onClick={linkPane.close}>
          <X size={13} aria-hidden />
        </IconButton>
      </div>

      <p className="m-0 text-xs leading-relaxed text-muted">
        {props.target.kind === "version" ? (
          <>Share {subject}.</>
        ) : (
          <>
            Share <code className="font-mono text-[11px] text-ink">{subject}</code>.
          </>
        )}
      </p>

      <div
        role="radiogroup"
        aria-label="Share with"
        className="flex rounded-lg border border-line bg-panel-2 p-0.5"
      >
        <button
          type="button"
          role="radio"
          aria-checked={shareWith === "email"}
          onClick={() => setShareWith("email")}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
            shareWith === "email"
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          Invite by email
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={shareWith === "link"}
          onClick={() => setShareWith("link")}
          className={`flex-1 rounded-md px-2.5 py-1 text-xs transition-colors ${
            shareWith === "link"
              ? "bg-bg text-ink shadow-sm"
              : "text-muted hover:text-ink"
          }`}
        >
          Anyone with the link
        </button>
      </div>

      <EmailShareForm
        workspaceId={props.workspaceId}
        target={props.target}
        visible={shareWith === "email"}
        onDone={linkPane.close}
      />
      {linkPane.content}
    </div>
  );
}
