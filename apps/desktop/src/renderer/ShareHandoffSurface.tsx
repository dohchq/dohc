import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ShareHandoffStatus } from "../ipc/bridgeContract";
import { bridge } from "./bridge";
import { CloudLogin } from "./CloudLogin";
import type { Workspace } from "./DesktopWorkspaceShell";
import { OpenSharedView } from "./OpenSharedView";
import { IconButton, PrimaryButton, SecondaryButton } from "./ui/controls";

const REFUSED_COPY =
  "dohc couldn't open this share link. It may have expired or already been used. Go back to the share page in your browser and choose Open in dohc again.";
const NETWORK_COPY =
  "dohc couldn't reach dohc Cloud. Check your connection, then choose Try again.";
const BUSY_COPY =
  "dohc Cloud is busy right now. Wait a moment, then choose Try again.";
const MISSING_COPY =
  "dohc couldn't find this share in your account. The person who shared it may have ended it.";

type InventoryState =
  | { kind: "idle" }
  | { kind: "loading"; shareId: string }
  | { kind: "missing"; shareId: string }
  | { kind: "failed"; shareId: string }
  | { kind: "ready"; shareId: string; shareCode: string };

function HandoffCard(props: {
  title: string;
  onBack?: () => void;
  children?: ReactNode;
}) {
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
        <h2 className="m-0 text-sm font-semibold text-ink">{props.title}</h2>
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
  mountInto?: {
    workspaceId: string;
    onMounted: (label: string) => void;
  };
}) {
  const shareId = props.status.status === "done" ? props.status.shareId : null;
  const [inventoryAttempt, setInventoryAttempt] = useState(0);
  const [inventory, setInventory] = useState<InventoryState>({ kind: "idle" });
  const inventoryRequest = useRef(0);

  useEffect(() => {
    const request = ++inventoryRequest.current;
    let active = true;
    if (shareId === null) {
      setInventory({ kind: "idle" });
      return () => {
        active = false;
        inventoryRequest.current += 1;
      };
    }

    setInventory({ kind: "loading", shareId });
    void bridge()
      .listRelayShares()
      .then((result) => {
        if (!active || request !== inventoryRequest.current) return;
        const received = result.received.find((row) => row.shareId === shareId);
        setInventory(
          received
            ? { kind: "ready", shareId, shareCode: received.shareCode }
            : { kind: "missing", shareId },
        );
      })
      .catch(() => {
        if (!active || request !== inventoryRequest.current) return;
        setInventory({ kind: "failed", shareId });
      });

    return () => {
      active = false;
      inventoryRequest.current += 1;
    };
  }, [inventoryAttempt, shareId]);

  if (props.status.status === "idle") return null;

  if (props.status.status === "waiting-for-sign-in") {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p className="m-0 text-xs leading-relaxed text-muted">
          Sign in to open the share from your browser.
        </p>
        <CloudLogin onConnected={() => undefined} embedded />
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
    inventory.kind === "ready" &&
    inventory.shareId === shareId
  ) {
    return (
      <OpenSharedView
        key={inventory.shareId}
        resolvedShare={{
          shareId: inventory.shareId,
          shareCode: inventory.shareCode,
        }}
        onWorkspaceReady={props.onWorkspaceReady}
        onBack={props.onBack}
        onOpened={props.onOpened}
        {...(props.mountInto ? { mountInto: props.mountInto } : {})}
      />
    );
  }

  if (
    inventory.kind === "missing" &&
    inventory.shareId === shareId
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {MISSING_COPY}
        </p>
        <SecondaryButton
          type="button"
          onClick={() => setInventoryAttempt((attempt) => attempt + 1)}
        >
          Check again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  if (
    inventory.kind === "failed" &&
    inventory.shareId === shareId
  ) {
    return (
      <HandoffCard title="Open a share" onBack={props.onBack}>
        <p role="alert" className="m-0 text-xs leading-relaxed text-danger">
          {NETWORK_COPY}
        </p>
        <SecondaryButton
          type="button"
          onClick={() => setInventoryAttempt((attempt) => attempt + 1)}
        >
          Try again
        </SecondaryButton>
      </HandoffCard>
    );
  }

  return <HandoffCard title="Opening share…" onBack={props.onBack} />;
}
