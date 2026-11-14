import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { Overlay } from "../Overlay";
import { FieldError, PrimaryButton, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { T3CodeChoice, type T3CodeThreadChoice } from "./T3CodeThread";

/**
 * Connects an agent to another T3 Code thread. The new thread gets dohc's
 * introduction first, and `onChanged` then saves the agent with it, so a
 * thread T3 Code refuses is never saved. While that runs the dialog stays
 * open. A refusal says why above the buttons and keeps the choice.
 */
export function ChangeThreadDialog(props: {
  workspaceId: string;
  agentId: string;
  agentName: string;
  // The thread the agent has now.
  threadId: string;
  // The new thread is ready: save the agent with it.
  onChanged: (threadId: string) => void;
  onClose: () => void;
}) {
  const { workspaceId, agentId, agentName } = props;
  const [thread, setThread] = useState<T3CodeThreadChoice | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  // An answer for a dialog that is gone, or for another agent or workspace, changes nothing.
  const changes = useRequestSequence([workspaceId, agentId]);
  // The answer saves through the newest render's settings, not the ones it started with.
  const latest = useRef(props);
  latest.current = props;
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const choice = useRef<HTMLDivElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  const pick = useCallback((next: T3CodeThreadChoice | null) => {
    setThread(next);
    setFailure(null);
  }, []);
  const same = thread?.id === props.threadId;

  // The dialog holds focus until its first control shows: the project field,
  // or the button that asks T3 Code while dohc is not allowed there. Focus the
  // person moved stays where they put it.
  useLayoutEffect(() => {
    const held = choice.current;
    if (!held) return;
    const land = () => {
      const field = held.querySelector<HTMLElement>("select, input");
      if (field) observer.disconnect();
      const active = document.activeElement;
      if (active !== panel.current && active !== document.body) return;
      (field ?? held.querySelector<HTMLElement>("[data-t3-code-allow-step] button"))?.focus();
    };
    const observer = new MutationObserver(land);
    observer.observe(held, { childList: true, subtree: true });
    land();
    return () => observer.disconnect();
  }, []);
  // A refusal leaves focus on the button that asks again.
  useLayoutEffect(() => {
    if (failure) submit.current?.focus();
  }, [failure]);

  async function change() {
    if (busyRef.current || !thread || same) return;
    const threadId = thread.id;
    const token = changes.next();
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await bridge().changeAgentThread({ workspaceId, agentId, threadId });
    } catch (cause) {
      if (!changes.isCurrent(token)) return;
      busyRef.current = false;
      setBusy(false);
      setFailure(ipcErrorMessage(cause, `dohc could not change ${agentName}'s thread.`));
      return;
    }
    if (!changes.isCurrent(token)) return;
    latest.current.onChanged(threadId);
    latest.current.onClose();
  }

  const note = failure ? `${id}-failure` : same ? `${id}-same` : undefined;
  return (
    <Overlay
      panelRef={panel}
      onClose={() => {
        if (!busyRef.current) props.onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
        data-testid="agent-thread-change-dialog"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void change();
        }}
        className="dohc-elevated flex w-[480px] max-w-[calc(100vw-2rem)] flex-col gap-6 rounded-xl border border-line bg-panel p-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id={`${id}-title`} className="m-0 text-base font-semibold text-ink wrap-anywhere">
            Change {agentName}&apos;s thread
          </h2>
          <p id={`${id}-body`} className="m-0 text-[13px] text-muted">
            From now on, dohc forwards to the thread you choose, and the old thread keeps the
            messages it has.
          </p>
        </div>
        {/* The choice holds still while its thread is readied. */}
        <div ref={choice} inert={busy} className="flex flex-col gap-4">
          <T3CodeChoice
            picked={thread?.id ?? null}
            onPick={pick}
            error={null}
            searchId={`${id}-search`}
            onReady={setReady}
          />
        </div>
        <div className="flex flex-col gap-3">
          {failure ? (
            <FieldError id={`${id}-failure`} testId="agent-thread-change-error">
              {failure}
            </FieldError>
          ) : same ? (
            // Why Change thread is off for this choice.
            <p
              id={`${id}-same`}
              role="status"
              data-testid="agent-thread-change-same"
              className="m-0 text-[12px] text-muted"
            >
              This is already {agentName}&apos;s thread.
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <SecondaryButton
              data-testid="agent-thread-change-cancel"
              disabled={busy}
              onClick={props.onClose}
            >
              Cancel
            </SecondaryButton>
            {ready ? (
              // Until dohc is allowed in T3 Code there is no thread to change to.
              <PrimaryButton
                ref={submit}
                type="submit"
                data-testid="agent-thread-change-confirm"
                aria-describedby={note}
                disabled={busy || thread === null || same}
              >
                {busy ? "Changing…" : "Change thread"}
              </PrimaryButton>
            ) : null}
          </div>
        </div>
      </form>
    </Overlay>
  );
}
