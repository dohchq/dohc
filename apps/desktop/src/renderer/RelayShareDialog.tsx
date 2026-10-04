import { Share2, X } from "lucide-react";
import { useState } from "react";
import { EmailShareForm } from "./EmailShareForm";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { IconButton } from "./ui/controls";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";
import { useRelayShareLinkPane } from "./useRelayShareLinkPane";

export type RelayShareTarget =
  | { kind: "paths"; paths: [string, ...string[]]; label?: string }
  | { kind: "version"; versionId: string; versionName?: string };

type ShareWith = "email" | "link";
const SHARE_WITH_OPTIONS: ReadonlyArray<SegmentedOption<ShareWith>> = [
  { value: "email", label: "Invite by email" },
  { value: "link", label: "Anyone with the link" },
];

export function RelayShareDialog(props: {
  workspaceId: string;
  target: RelayShareTarget;
  onClose: () => void;
  // Ending a link or a person's access: the shell shows the notice and its Undo.
  shareRemovals?: ShareRemovalNotices;
}) {
  const [shareWith, setShareWith] = useState<ShareWith>("email");
  const linkPane = useRelayShareLinkPane({
    workspaceId: props.workspaceId,
    target: props.target,
    visible: shareWith === "link",
    onClose: props.onClose,
    ...(props.shareRemovals ? { shareRemovals: props.shareRemovals } : {}),
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

      <SegmentedControl
        label="Share with"
        value={shareWith}
        options={SHARE_WITH_OPTIONS}
        onChange={setShareWith}
      />

      <EmailShareForm
        key={linkPane.scope}
        workspaceId={props.workspaceId}
        target={props.target}
        visible={shareWith === "email"}
        onDone={linkPane.close}
      />
      {linkPane.content}
    </div>
  );
}
