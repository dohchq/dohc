import { useId, useLayoutEffect, useRef, useState } from "react";
import { Forward } from "lucide-react";
import type { Agent } from "../../settings/userSettings";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import {
  ConfirmActions,
  ConfirmationCard,
  ConfirmationHead,
  FOCUS_RING,
  confirmPanel,
  useOpeningFocus,
} from "../ui/ConfirmDialog";
import { FieldError, PrimaryButton, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";

/**
 * Asks before an agent's thread gets one more workspace's messages, and says
 * what the thread then holds (ADR 0016). On yes, main tells the thread and
 * then saves the agent with the workspace, so a thread dohc could not tell is
 * never saved. The dialog stays open until main answers. A refusal, or a save
 * that failed, says why above the buttons, and the same button asks again.
 */
export function ForwardWorkspaceDialog(props: {
  workspaceId: string;
  workspaceName: string;
  agent: Agent;
  onClose: () => void;
}) {
  const { workspaceId, agent } = props;
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // An answer for a dialog that is gone, or for another agent or workspace, changes nothing.
  const asks = useRequestSequence([workspaceId, agent.id]);
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useOpeningFocus(() => confirm.current);
  // A refusal leaves focus on the button that asks again.
  useLayoutEffect(() => {
    if (failure) confirm.current?.focus();
  }, [failure]);

  async function turnOn() {
    if (busyRef.current) return;
    const token = asks.next();
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await bridge().setAgentThreadWorkspace({ workspaceId, agentId: agent.id, on: true });
    } catch (cause) {
      if (!asks.isCurrent(token)) return;
      busyRef.current = false;
      setBusy(false);
      setFailure(
        ipcErrorMessage(cause, `dohc could not tell ${agent.name}'s thread about this workspace.`),
      );
      return;
    }
    if (asks.isCurrent(token)) props.onClose();
  }

  const others = (agent.workspaces ?? []).filter((other) => other !== workspaceId).length;
  const from = props.workspaceName.trim() || "this workspace";
  return (
    <Overlay
      panelRef={panel}
      panelProps={confirmPanel(`${id}-title`, `${id}-body`)}
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <ConfirmationCard icon={Forward} testId="agent-workspace-dialog">
        <ConfirmationHead
          titleId={`${id}-title`}
          bodyId={`${id}-body`}
          title={`Forward messages from ${from} to ${agent.name}?`}
        >
          {/* dohc forwards only to an agent that is on, and only what comes after this. */}
          <p className="m-0">
            {`${agent.enabled ? "dohc will forward" : "Once Forward messages is on, dohc will forward"} messages from this workspace to ${agent.name}'s thread, which ${
              others === 0
                ? "keeps every message it already has from any workspace"
                : `also holds messages from ${others} other ${others === 1 ? "workspace" : "workspaces"}`
            }.`}
          </p>
          <p className="m-0">
            What the thread learns in one workspace can appear in what it posts in another, where
            other people can read it.
          </p>
        </ConfirmationHead>
        <div className="flex flex-col gap-3">
          {failure ? (
            <FieldError id={`${id}-failure`} testId="agent-workspace-error">
              {failure}
            </FieldError>
          ) : null}
          <ConfirmActions>
            <SecondaryButton
              data-testid="agent-workspace-cancel"
              className={FOCUS_RING}
              disabled={busy}
              onClick={props.onClose}
            >
              Cancel
            </SecondaryButton>
            <PrimaryButton
              ref={confirm}
              data-testid="agent-workspace-confirm"
              className={FOCUS_RING}
              aria-describedby={failure ? `${id}-failure` : undefined}
              disabled={busy}
              onClick={() => void turnOn()}
            >
              {busy ? "Turning on…" : "Forward from this workspace"}
            </PrimaryButton>
          </ConfirmActions>
        </div>
      </ConfirmationCard>
    </Overlay>
  );
}
