import { Check } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { ScheduleHostComputer, ScheduleHostResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import { ipcErrorMessage } from "../ipcError";
import { PrimaryButton, SecondaryButton } from "../ui/controls";
import { useRequestSequence } from "../useRequestSequence";
import { SettingRow } from "./SettingRow";

// "Schedules run on": which of the owner's computers runs this workspace's
// schedules. Choosing another starts a handover; while it waits, the old
// computer's last check-in shows, with a way to take over without it.

const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** How a computer shows: its name, or "This computer" for this one. */
export function computerName(computer: Pick<ScheduleHostComputer, "label" | "thisComputer">): string {
  return computer.thisComputer ? "This computer" : computer.label;
}

type Loaded = { status: "loading" } | { status: "ready"; state: ScheduleHostResult } | { status: "failed" };

export function ScheduleHostRow(props: { workspaceId: string; onError?: (message: string) => void }) {
  const { workspaceId, onError } = props;
  const requests = useRequestSequence([workspaceId]);
  const [loaded, setLoaded] = useState<Loaded>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [confirmingTakeOver, setConfirmingTakeOver] = useState(false);
  const takeOverRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const computerRefs = useRef<Array<HTMLButtonElement | null>>([]);
  // The computer the list's one tab stop is on: the focused one once focus
  // moves, and the chosen one until then.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const warningId = useId();

  const run = useCallback(
    async (ask: () => Promise<ScheduleHostResult>, fallback: string) => {
      const token = requests.next();
      setBusy(true);
      try {
        const state = await ask();
        if (!requests.isCurrent(token)) return;
        setLoaded({ status: "ready", state });
        setConfirmingTakeOver(false);
      } catch (error) {
        if (!requests.isCurrent(token)) return;
        onError?.(ipcErrorMessage(error, fallback));
        setLoaded((current) => (current.status === "ready" ? current : { status: "failed" }));
      } finally {
        if (requests.isCurrent(token)) setBusy(false);
      }
    },
    [onError, requests],
  );
  const read = useCallback(
    () => run(() => bridge().readScheduleHost({ workspaceId }), "dohc could not read which computer runs schedules."),
    [run, workspaceId],
  );
  useEffect(() => {
    setLoaded({ status: "loading" });
    void read();
  }, [read]);
  // Another account's answer never fills the row: a session change starts
  // over, and reads again once the new session is ready.
  useEffect(() => bridge().onCloudSessionChanged(({ phase }) => {
    requests.next();
    setBusy(false);
    setConfirmingTakeOver(false);
    setLoaded({ status: "loading" });
    if (phase === "ready") void read();
  }), [read, requests]);
  // A handover that finished in the background, or a choice from another
  // window, shows here.
  useEffect(() => bridge().onScheduleHostChanged((changed) => {
    if (changed === workspaceId) void read();
  }), [read, workspaceId]);
  // The confirmation takes focus on its safe choice.
  useEffect(() => {
    if (confirmingTakeOver) cancelRef.current?.focus();
  }, [confirmingTakeOver]);

  if (loaded.status === "loading") return null;
  if (loaded.status === "failed") {
    return (
      <SettingRow title="Schedules run on" testId="settings-row-schedule-host">
        <SecondaryButton size="compact" disabled={busy} onClick={() => void read()}>Try again</SecondaryButton>
      </SettingRow>
    );
  }
  const { state } = loaded;
  if (state.kind === "none") return null;
  if (state.kind === "this-computer" || state.kind === "note") {
    return (
      <SettingRow title="Schedules run on" testId="settings-row-schedule-host">
        <span data-testid="schedule-host-note" className="text-[12px] text-muted">
          {state.kind === "this-computer" ? "This computer" : state.message}
        </span>
      </SettingRow>
    );
  }

  const handingOver = state.handoverFrom === null
    ? null
    : state.computers.find((computer) => computer.installId === state.handoverFrom) ?? null;
  const choose = (computer: ScheduleHostComputer) =>
    void run(
      () => bridge().chooseScheduleHost({ workspaceId, installId: computer.installId, generation: state.generation }),
      "dohc could not move this workspace's schedules.",
    );
  const takeOver = () =>
    void run(
      () => bridge().takeOverScheduleHost({ workspaceId, generation: state.generation }),
      "dohc could not take over this workspace's schedules.",
    );
  const cancelTakeOver = () => {
    setConfirmingTakeOver(false);
    // The trigger comes back in place of the confirmation.
    requestAnimationFrame(() => takeOverRef.current?.focus());
  };
  // One tab stop for the list; arrows, Home, and End move between computers.
  const focusedIndex = state.computers.findIndex((computer) => computer.installId === focusedId);
  const chosenIndex = state.computers.findIndex((computer) => computer.installId === state.hostInstallId);
  const tabStop = focusedIndex !== -1 ? focusedIndex : chosenIndex !== -1 ? chosenIndex : 0;
  const moveFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = state.computers.length - 1;
    const target = event.key === "ArrowDown" || event.key === "ArrowRight" ? Math.min(index + 1, last)
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? Math.max(index - 1, 0)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : null;
    if (target === null) return;
    event.preventDefault();
    computerRefs.current[target]?.focus();
  };

  return (
    <SettingRow title="Schedules run on" testId="settings-row-schedule-host">
      <div className="flex min-w-[260px] flex-col gap-2">
        <div role="group" aria-label="Schedules run on" className="flex flex-col">
          {state.computers.map((computer, index) => {
            const chosen = computer.installId === state.hostInstallId;
            return (
              <button
                key={computer.installId}
                ref={(element) => { computerRefs.current[index] = element; }}
                type="button"
                aria-pressed={chosen}
                tabIndex={index === tabStop ? 0 : -1}
                data-testid={`schedule-host-${computer.installId}`}
                disabled={busy}
                onKeyDown={(event) => moveFocus(event, index)}
                onFocus={() => setFocusedId(computer.installId)}
                onClick={() => { if (!chosen) choose(computer); }}
                className={`flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left text-[13px] transition-colors duration-75 disabled:cursor-default ${
                  chosen ? "bg-line/60 text-ink" : "text-muted hover:bg-panel-2 hover:text-ink"
                }`}
              >
                <span className="grid size-4 place-items-center" aria-hidden>
                  {chosen ? <Check size={12} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{computerName(computer)}</span>
                <span className="shrink-0 font-mono text-[11px] text-subtle">
                  {dayFormat.format(computer.lastSeenMs)}
                </span>
              </button>
            );
          })}
        </div>
        {handingOver ? (
          <div data-testid="schedule-host-handover" className="flex flex-col gap-2">
            <p className="m-0 text-[12px] text-muted">
              {handingOver.thisComputer
                ? "Waiting for this computer to hand over."
                : `Waiting for ${handingOver.label} to hand over. Last seen ${dayFormat.format(handingOver.lastSeenMs)}.`}
            </p>
            {confirmingTakeOver ? (
              <div className="flex flex-col gap-2">
                <p id={warningId} role="alert" className="m-0 text-[12px] text-ink">
                  If {computerName(handingOver)} is still on, a run can repeat.
                </p>
                <div className="flex gap-2">
                  <PrimaryButton size="compact" aria-describedby={warningId} disabled={busy} onClick={takeOver}>
                    Take over now
                  </PrimaryButton>
                  <SecondaryButton
                    ref={cancelRef}
                    size="compact"
                    aria-describedby={warningId}
                    disabled={busy}
                    onClick={cancelTakeOver}
                  >
                    Cancel
                  </SecondaryButton>
                </div>
              </div>
            ) : (
              <SecondaryButton
                ref={takeOverRef}
                size="compact"
                className="self-start"
                disabled={busy}
                onClick={() => setConfirmingTakeOver(true)}
              >
                Take over now
              </SecondaryButton>
            )}
          </div>
        ) : null}
      </div>
    </SettingRow>
  );
}
