import { useEffect, useRef } from "react";
import type { ScheduleHostResult } from "../../ipc/bridgeContract";
import { bridge } from "../bridge";
import type { useShellError } from "./useShellError";

type Shell = ReturnType<typeof useShellError>;

/** The Notices row for where a workspace that never synced runs its schedules, or null for none. */
export function scheduleHostNoticeText(state: ScheduleHostResult): { message: string; failed: boolean; cause?: string } | null {
  if (state.kind === "no-computer") return { message: state.message, failed: true, ...(state.cause ? { cause: state.cause } : {}) };
  if (state.kind !== "another-computer" || !state.waits) return null;
  const where = state.sameName
    ? `This workspace's schedules and Group messages run on ${state.label}, which has this computer's name. It may be an earlier installation of dohc here.`
    : `This workspace's schedules and Group messages run on ${state.label}, not this computer.`;
  return { message: `${where} If you take over while ${state.label} is on, a run can repeat.`, failed: false };
}

/**
 * Tells the person when this computer has schedules or Group triggers that
 * another computer runs, or that no computer runs, with Take over now. Reads when the
 * workspace opens and whenever main says where schedules run may have
 * changed, as when this computer first finds such automations. It never asks a
 * synced workspace's relay. A failed read says nothing here: Settings shows it.
 */
export function useScheduleHostNotice(input: {
  workspaceId: string;
  ready: boolean;
  show: Shell["showScheduleHostNotice"];
  report: Shell["reportShellFailure"];
}): void {
  const { workspaceId, ready, show, report } = input;
  const currentWorkspace = useRef(workspaceId);
  currentWorkspace.current = workspaceId;
  useEffect(() => {
    if (!ready) return;
    let active = true;
    let latest = 0;
    const isCurrent = () => active && currentWorkspace.current === workspaceId;
    const answer = (request: number, state: ScheduleHostResult) => {
      if (!isCurrent() || request !== latest) return;
      const text = scheduleHostNoticeText(state);
      show(text && { ...text, retry: () => void read(), takeOver });
    };
    const read = () => {
      const request = ++latest;
      return bridge().readScheduleHost({ workspaceId, localOnly: true }).then((state) => answer(request, state), () => undefined);
    };
    const takeOver = () => {
      const request = ++latest;
      bridge().takeOverScheduleHost({ workspaceId, generation: 0 }).then((state) => answer(request, state), (cause: unknown) => {
        if (isCurrent()) report({ message: "dohc could not take over this workspace's schedules.", cause, retry: takeOver });
      });
    };
    void read();
    const unsubscribe = bridge().onScheduleHostChanged((changed) => {
      if (changed === workspaceId) void read();
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [workspaceId, ready, show, report]);
}
