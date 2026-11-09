import { CloudOff, LogIn, Share2, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SYNC_UNCONFIRMED_ACCOUNT } from "./cloudSyncWords";
import { EmailShareForm } from "./EmailShareForm";
import type { ShareRemovalNotices } from "./shell/useShareRemovalNotices";
import { IconButton, PrimaryButton } from "./ui/controls";
import { SegmentedControl, type SegmentedOption } from "./ui/SegmentedControl";
import { useRelayShareLinkPane } from "./useRelayShareLinkPane";
import { accessReasonForLane, serverName, type AccessContext, type AccessReason } from "./workbench/accessReason";

export type RelayShareTarget =
  | { kind: "paths"; paths: [string, ...string[]]; label?: string }
  | { kind: "version"; versionId: string; versionName?: string };

// Fits the dialog under Overlay's 6rem top and above its 1rem bottom and the
// toasts, so a long link pane grows it downward and its body scrolls.
const DIALOG_HEIGHT_CLASS = "max-h-[calc(100vh_-_7rem_-_var(--dohc-toast-room,0px))]";

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
  // The shell's useDisconnectedLinkAgents set, so a link's Agents list leaves them out.
  disconnectedAgents?: ReadonlySet<string>;
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
    ...(props.disconnectedAgents ? { disconnectedAgents: props.disconnectedAgents } : {}),
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

  // While the body scrolls, the title sits in a band with a rule. The band
  // keeps the dialog's 20px inset, so only the rule comes in.
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setScrolls(body.scrollHeight > body.clientHeight));
    observer.observe(body);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      data-testid="share-dialog"
      data-scrolls={scrolls ? "" : undefined}
      className={`dohc-elevated flex w-105 flex-col rounded-xl border border-line bg-panel ${scrolls ? "" : "gap-3 p-5"} ${DIALOG_HEIGHT_CLASS}`}
    >
      <div className={`flex flex-col gap-3 ${scrolls ? "border-b border-line px-5 pb-4 pt-5" : ""}`}>
        <div className="flex items-center gap-2">
          <Share2 size={14} aria-hidden className="text-subtle" />
          <h2 className="m-0 flex-1 text-base font-semibold text-ink">Share</h2>
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
      </div>

      {/* A control's halo draws inset here, where the scroller would clip it. */}
      <div
        ref={bodyRef}
        data-testid="share-dialog-body"
        className={`min-h-0 overflow-y-auto [&_:focus-visible]:-outline-offset-2 ${scrolls ? "px-5 pb-5 pt-4" : "-mx-5 -my-1 px-5 py-1"}`}
      >
        <div ref={contentRef} className="flex flex-col gap-3">
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
      className="flex items-center gap-2 rounded-lg bg-panel-2 p-2 text-[12px] leading-4 text-ink"
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

