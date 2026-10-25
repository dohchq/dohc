import { CloudOff, LogIn, Share2, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { SYNC_UNCONFIRMED_ACCOUNT } from "./cloudSyncWords";
import { EmailShareForm } from "./EmailShareForm";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { IconButton, PrimaryButton } from "./ui/controls";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";
import { useRelayShareLinkPane } from "./useRelayShareLinkPane";
import { accessReasonForLane, type AccessContext, type AccessReason } from "./workbench/accessReason";

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
  // What About's Access reads, so Share names the same cause.
  accessContext: AccessContext;
  // The server this workspace syncs with, when it syncs.
  server: string | null;
}) {
  const [shareWith, setShareWith] = useState<ShareWith>("email");
  const linkPane = useRelayShareLinkPane({
    workspaceId: props.workspaceId,
    target: props.target,
    visible: shareWith === "link",
    onClose: props.onClose,
    ...(props.shareRemovals ? { shareRemovals: props.shareRemovals } : {}),
  });
  // The forms show but take no input while a cause dohc can name stops a
  // share, or while it is still read. Main still refuses a share it cannot
  // make, as when sync stops while the dialog is open.
  const reason = accessReasonForLane(props.accessContext.facts, "granted");
  const held = reason !== "unexplained";

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

      <ShareSetup reason={reason} context={props.accessContext} server={props.server} onLeave={linkPane.close} />

      <div inert={held || undefined} className={held ? "flex flex-col gap-3 opacity-50" : "flex flex-col gap-3"}>
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
    </div>
  );
}

// Why sharing cannot work yet, with the one action that changes it: the
// one About's Access offers for the same cause.
function ShareSetup(props: { reason: AccessReason; context: AccessContext; server: string | null; onLeave: () => void }) {
  const { context, server } = props;
  switch (props.reason) {
    case "checking":
    case "unexplained":
      return null;
    case "not-synced":
      return (
        <SetupBand reason="not-synced" icon={CloudOff} action="Set up sync" run={context.openSyncSettings} onLeave={props.onLeave}>
          <p className="m-0">Sharing needs sync.</p>
        </SetupBand>
      );
    case "signed-out":
      return (
        <SetupBand reason="signed-out" icon={LogIn} action="Connect server" run={context.connect} onLeave={props.onLeave}>
          <p className="m-0">
            Not connected to{" "}
            {server === null ? "this workspace's server" : <span className="font-medium">{serverName(server)}</span>}
          </p>
          <p className="m-0 text-muted">Others may have access.</p>
        </SetupBand>
      );
    case "other-account":
      return (
        <SetupBand reason="other-account" icon={CloudOff} action="Sync and sharing" run={context.openSyncSettings} onLeave={props.onLeave}>
          <p className="m-0">{SYNC_UNCONFIRMED_ACCOUNT} Resume sync to share.</p>
        </SetupBand>
      );
  }
}

// The action opens its own place, so the dialog closes first.
function SetupBand(props: {
  reason: AccessReason;
  icon: LucideIcon;
  action: string;
  run: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <div
      data-testid="share-setup"
      data-reason={props.reason}
      className="flex items-center gap-2 rounded-lg bg-panel-2 py-2 pl-2.5 pr-2 text-[12px] leading-4 text-ink"
    >
      <Icon size={14} aria-hidden className="shrink-0 text-muted" />
      <div className="min-w-0 flex-1">{props.children}</div>
      <PrimaryButton
        size="compact"
        className="shrink-0"
        onClick={() => {
          props.onLeave();
          props.run();
        }}
      >
        {props.action}
      </PrimaryButton>
    </div>
  );
}

// A server by its host, as a person reads its address: sync.example.org.
function serverName(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}
