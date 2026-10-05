import type { DesktopMarksResult } from "../ipc/bridgeContract";
import {
  createMarkRecorder,
  type MarksSnapshot,
  type SwitchCompletionPhase,
  type SwitchPhaseDetails,
  type SwitchTimelineEntry,
} from "./desktopMarks";
import { profileCounters, type ProfileCountersSnapshot } from "./profileCounters";

export type { SwitchCompletionPhase, SwitchPhaseDetails };

// The renderer-process recorder (separate instance from main's desktopMarks —
// the renderer is a separate bundle and process).
export const rendererMarks = createMarkRecorder();

export function readSwitchTimeline(): SwitchTimelineEntry[] {
  return rendererMarks.readSwitchTimeline();
}

export function fileOpenStartMark(groupId: string): string {
  return `file-open-start:${groupId}`;
}

declare global {
  interface Window {
    // The preload flag alone does not authorize diagnostics in a packaged app.
    dohcDesktopTest?: unknown;
    dohcDesktopMarks?: {
      snapshot(): MarksSnapshot;
      readSwitchTimeline(): SwitchTimelineEntry[];
      counters(): ProfileCountersSnapshot | null;
    };
  }
}

// Main registers this capability only for an unpackaged desktop test process.
export async function installRendererDiagnostics(target: Window): Promise<void> {
  const candidate = target.dohcDesktopTest;
  if (!candidate || typeof candidate !== "object" || !("getDesktopMarks" in candidate) || typeof candidate.getDesktopMarks !== "function") return;
  try {
    const acknowledgement: Pick<DesktopMarksResult, "counters"> | null | undefined = await candidate.getDesktopMarks();
    if (!acknowledgement?.counters || target.dohcDesktopTest !== candidate) return;
  } catch { return; }
  profileCounters.enable();
  target.dohcDesktopMarks = {
    snapshot: () => rendererMarks.snapshot(),
    readSwitchTimeline,
    counters: () => profileCounters.snapshot(),
  };
}
if (typeof window !== "undefined" && window.dohcDesktopTest !== undefined) void installRendererDiagnostics(window);
