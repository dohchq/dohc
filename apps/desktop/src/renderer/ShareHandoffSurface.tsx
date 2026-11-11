import type {RelayShareReceivedRow} from "../ipc/bridgeContract";
import { useMouseBackButton } from "./useMouseBackButton";
import { useRequestSequence } from "./useRequestSequence";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShareAccess, ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import { OpenSharedView, opensForLiveEditing } from "./OpenSharedView";
import type { ConnectionNoticeHost } from "./shell/connectionNotices";
import { CopyButton } from "./ui/CopyButton";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";
import { inputCount } from "./ui/inputCount";

const REFUSED_COPY =
  "dohc could not open this share link. It may have expired or already been used. Go back to the share page in your browser and choose Open in dohc again.";
const NETWORK_COPY =
  "dohc could not reach the server. Check your connection, then choose Try again.";
const BUSY_COPY =
  "The server is busy right now. Wait a moment, then choose Try again.";
const MISSING_COPY =
  "dohc could not find this share in your account. The person who shared it may have ended it.";
// A Group invitation or message request waits in Chats.
const CHATS_COPY = "Find it in Chats, in a workspace of your own.";
const NO_OWN_WORKSPACE_COPY = `${CHATS_COPY} Create one from Manage workspaces first.`;
// What Chats found when it could not show the invitation.
const CHATS_OUTCOME_COPY = {
  absent: "This invitation isn't in this account's list in Chats. The person who shared it may have ended it.",
  failed: "dohc could not read Chats to find this invitation. Check your connection.",
} as const;

type ReceivedShareState =
  | { kind: "idle" }
  | { kind: "loading"; shareId: string }
  | { kind: "missing"; shareId: string }
  | { kind: "failed"; shareId: string }
  // `inputs` counts input before the lookup, so a click elsewhere during it
  // keeps Join from taking focus.
  | { kind: "chats"; shareId: string; inputs: number }
  | { kind: "ready"; shareId: string; shareCode: string; liveEditing: boolean; share: RelayShareReceivedRow };

function HandoffCard(props: {
  title: string;
  onBack?: () => void;
  children?: ReactNode;
}) {
  useMouseBackButton(props.onBack);
  return (
    <div
      data-testid="share-handoff-surface"
      className="dohc-elevated flex w-105 flex-col gap-3 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex items-center gap-2">
        {props.onBack ? (
          <IconButton aria-label="Back" onClick={props.onBack} className="shrink-0">
            <ArrowLeft size={13} aria-hidden />
          </IconButton>
        ) : null}
        <h2 className="m-0 text-base font-semibold text-ink">{props.title}</h2>
      </div>
      {props.children}
    </div>
  );
}

export function ShareHandoffSurface(props: {
  status: ShareHandoffStatus;
  onWorkspaceReady: (workspace: Workspace) => void;
  onBack: () => void;
  onOpened: () => void;
  // Whether the person has a workspace of their own, not only shared views.
  ownWorkspace?: boolean;
  // Shows Chats at a Group invitation or message request, where it waits
  // with Join or Accept. Without it, the card says where to find it.
  openInChats?: (invitation: { shareId: string; inputs: number }) => void;
  // Why Chats has not shown it yet, and Try again, which reads Chats again.
  chatsOutcome?: { shareId: string; outcome: "absent" | "failed" };
  onRetryChats?: () => void;
  mountInto?: {
    workspaceId: string;
    onMounted: (label: string, access: ShareAccess | null) => void;
  };
} & ConnectionNoticeHost) {
  const shareId = props.status.status === "done" ? props.status.shareId : null;
  const [lookupAttempt, setLookupAttempt] = useState(0);
  const [receivedShare, setReceivedShare] = useState<ReceivedShareState>({
    kind: "idle",
  });
  const lookupRequest = useRequestSequence();
  // The acceptance card has no Back control; Cancel is its way out, so the
  // mouse's back button follows Cancel there.
  useMouseBackButton(
    props.status.status === "waiting-for-acceptance" ? props.onBack : undefined,
  );

  useEffect(() => {
    const request = lookupRequest.next();
    if (shareId === null) {
      setReceivedShare({ kind: "idle" });
      return () => {
        lookupRequest.next();
      };
    }

    const inputs = inputCount();
    setReceivedShare({ kind: "loading", shareId });
    void bridge()
      .getRelayReceivedShare({ shareId })
      .then((result) => {
        if (!lookupRequest.isCurrent(request)) return;
        setReceivedShare(
          !result.found
            ? { kind: "missing", shareId }
            : "chats" in result
              ? { kind: "chats", shareId, inputs }
              : { kind: "ready", shareId, shareCode: result.share.shareCode, share: result.share, liveEditing: opensForLiveEditing(result.share) },
        );
      })
      .catch(() => {
        if (!lookupRequest.isCurrent(request)) return;
        setReceivedShare({ kind: "failed", shareId });
      });

    return () => {
      lookupRequest.next();
    };
  }, [lookupAttempt, shareId]);

  const chatsInvitation = receivedShare.kind === "chats" && receivedShare.shareId === shareId && props.openInChats !== undefined
    ? receivedShare : null;
  const opensInChats = chatsInvitation !== null;
  const openInChats = useRef(props.openInChats);
  openInChats.current = props.openInChats;
  useEffect(() => {
    if (chatsInvitation) openInChats.current?.({ shareId: chatsInvitation.shareId, inputs: chatsInvitation.inputs });
  }, [chatsInvitation]);

  if (props.status.status === "idle") return null;

  if (props.status.status === "waiting-for-sign-in") {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p className="m-0 text-xs leading-relaxed text-muted">
          Connect your server to open the share from your browser.
        </p>
        <CloudLogin
          onConnected={() => undefined}
          embedded
          untitled
          onConnectionError={props.onConnectionError}
          initialServerUrl={props.initialServerUrl}
        />
      </HandoffCard>
    );
  }

  if (props.status.status === "waiting-for-acceptance") {
    const acceptanceStatus = props.status;
    return (
      <HandoffCard title="Open a share">
        <div className="flex flex-col gap-1 text-xs leading-relaxed text-muted">
          <p className="m-0">You're signed in as {acceptanceStatus.email}.</p>
          <p className="m-0">
            If you open this share, the person who shared it will see that email.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <PrimaryButton
            type="button"
            onClick={() =>
              void bridge()
                .acceptShareHandoff({ statusId: acceptanceStatus.statusId })
                .catch(() => undefined)
            }
          >
            Agree and open
          </PrimaryButton>
          <SecondaryButton type="button" onClick={props.onBack}>
            Cancel
          </SecondaryButton>
        </div>
      </HandoffCard>
    );
  }

  if (props.status.status === "redeeming") {
    return <HandoffCard title="Opening share…" onBack={props.onBack} />;
  }

  if (props.status.status === "failed-wrong-server") {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          This share link belongs to a different server ({props.status.linkRelayUrl})
          than the one you're signed in to. Sign in to that server, then choose Open
          in dohc again.
        </p>
      </HandoffCard>
    );
  }

  if (props.status.status === "failed-refused") {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {REFUSED_COPY}
        </p>
      </HandoffCard>
    );
  }

  if (
    props.status.status === "failed-network" ||
    props.status.status === "failed-busy"
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {props.status.status === "failed-busy" ? BUSY_COPY : NETWORK_COPY}
        </p>
        <SecondaryButton
          type="button"
          onClick={() => void bridge().retryShareHandoff().catch(() => undefined)}
        >
          Try again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  if (
    receivedShare.kind === "ready" &&
    receivedShare.shareId === shareId
  ) {
    return (
      <OpenSharedView
        key={receivedShare.shareId}
        liveEditing={receivedShare.liveEditing}
        resolvedShare={{
          shareId: receivedShare.shareId,
          shareCode: receivedShare.shareCode,
          share: receivedShare.share,
        }}
        onWorkspaceReady={props.onWorkspaceReady}
        onBack={props.onBack}
        onOpened={props.onOpened}
        onConnectionError={props.onConnectionError}
        initialServerUrl={props.initialServerUrl}
        {...(props.mountInto ? { mountInto: props.mountInto } : {})}
      />
    );
  }

  if (
    receivedShare.kind === "missing" &&
    receivedShare.shareId === shareId
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {MISSING_COPY}
        </p>
        <SecondaryButton
          type="button"
          onClick={() => setLookupAttempt((attempt) => attempt + 1)}
        >
          Check again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  if (
    receivedShare.kind === "chats" &&
    receivedShare.shareId === shareId &&
    !opensInChats
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="status" data-testid="handoff-opens-in-chats" className="m-0 text-xs leading-relaxed text-muted">
          {props.ownWorkspace ? CHATS_COPY : NO_OWN_WORKSPACE_COPY}
        </p>
      </HandoffCard>
    );
  }

  const chatsOutcome = opensInChats && props.chatsOutcome?.shareId === shareId ? props.chatsOutcome.outcome : null;
  if (chatsOutcome !== null) {
    const copy = CHATS_OUTCOME_COPY[chatsOutcome];
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <div className="flex items-start gap-2">
          <p role="alert" data-testid={`handoff-chats-${chatsOutcome}`} className="m-0 min-w-0 flex-1 text-xs leading-relaxed text-danger">
            {copy}
          </p>
          <CopyButton label="Copy" pinName iconOnly getText={() => copy} />
        </div>
        <SecondaryButton type="button" onClick={props.onRetryChats}>
          Try again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  if (
    receivedShare.kind === "failed" &&
    receivedShare.shareId === shareId
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {NETWORK_COPY}
        </p>
        <SecondaryButton
          type="button"
          onClick={() => setLookupAttempt((attempt) => attempt + 1)}
        >
          Try again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  return <HandoffCard title="Opening share…" onBack={props.onBack} />;
}
