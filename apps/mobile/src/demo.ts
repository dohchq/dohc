import { useEffect, useState } from "react";
import { Platform, Settings } from "react-native";
import type { SyncProblem } from "./notices/SyncBand";

// Design review only: `simctl spawn <device> defaults write app.dohc.mobile dohcDemo <mode>`, where mode is
// toast | band | band-empty | band-half-fold | band-late | band-long | band-return-scroll | band-cycle | band-cycle-scroll | band-sync-failed | band-problem-change | band-scrolled | band-toggle | notices-frames | notices-open | empty, or a sheet opened over Chats: sheet-forget | sheet-forget-waiting | sheet-delete-file |
// sheet-delete-files | sheet-leave | toast-forgot; on Sharing: sharing-empty | sheet-share-actions | sheet-end-share | sheet-end-share-waiting | toast-ended | toast-already-ended | toast-end-failed | toast-end-failed-many; on Notices: notice-end-failed | notice-clipped | notice-clipped-open | swipe-open; any tab: no-tint; on a page: page-opening | page-fail-read | page-fail-missing | page-fail-open | page-lossy-sheet | page-deleted | page-deleted-explain | page-offline | page-warm | page-type | page-lossy-consented | page-load-fails | page-cache-fails | page-no-space | page-cache-cleared | page-fonts-missing; launch-plain (time to the first usable screen). copies: notice-copied | toast-copied | share-copied (each copies, then shows the check).
export const demoMode: string | null = (() => {
  if (Platform.OS !== "ios") return null;
  const value: unknown = Settings.get("dohcDemo");
  return typeof value === "string" ? value : null;
})();

// Design review only: in band-half-fold, how far past its resting place the list starts, in points (`-dohcBandScroll
// <pt>`): 30 by default, or a fraction of the fold for the partway checks.
export const demoScroll: number = (() => {
  if (demoMode !== "band-half-fold") return 30;
  // A pull-down, by its own setting (`-dohcBandPull <pt>`), since a negative launch value reads as a new flag.
  const pull: unknown = Settings.get("dohcBandPull");
  const pulled = typeof pull === "number" ? pull : typeof pull === "string" ? Number(pull) : NaN;
  if (Number.isFinite(pulled)) return -pulled;
  const value: unknown = Settings.get("dohcBandScroll");
  const points = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(points) ? points : 30;
})();

// Stands in for the workspace's sync state until the phone talks to a server.
export const syncProblem: SyncProblem | null = (demoMode === "band" || demoMode === "band-empty" || demoMode === "band-half-fold" || demoMode === "band-problem-change" || demoMode === "band-scrolled") ? "serverUnreachable"
  // The longest body, for the capped band's long-body frames.
  : demoMode === "band-sync-failed" ? "syncFailed" : null;

/** The workspace's sync problem as state, so the band can arrive and leave while a screen is open. Design review
 * only: "band-toggle" shows it 8 s after the screen mounts and clears it 16 s after; "band-problem-change" shows
 * Server unreachable and changes it to Update dohc to sync 12 s after. */
export function useSyncProblem(): SyncProblem | null {
  const [problem, setProblem] = useState<SyncProblem | null>(syncProblem);
  useEffect(() => {
    // Long enough for a VoiceOver reading of the screen before it arrives, and another before it leaves.
    if (demoMode === "band-late") {
      const show = setTimeout(() => setProblem("serverUnreachable"), 60000);
      const clear = setTimeout(() => setProblem(null), 140000);
      return () => { clearTimeout(show); clearTimeout(clear); };
    }
    // Long enough to leave Notices and come back while it shows, then leave again while it clears.
    if (demoMode === "band-long" || demoMode === "band-return-scroll") {
      const show = setTimeout(() => setProblem("serverUnreachable"), 8000);
      const clear = setTimeout(() => setProblem(null), 40000);
      return () => { clearTimeout(show); clearTimeout(clear); };
    }
    // For the return trace: the band shows 2 s in, then turns off and on every 15 s, so one launch holds many returns.
    // A trial needs up to about 10 s to put the list in place before it leaves, so 6 s was too short.
    if (demoMode === "band-cycle" || demoMode === "band-cycle-scroll") {
      let shown = false;
      const start = setTimeout(() => setProblem("serverUnreachable"), 2000);
      const cycle = setInterval(() => { shown = !shown; setProblem(shown ? null : "serverUnreachable"); }, 15000);
      return () => { clearTimeout(start); clearInterval(cycle); };
    }
    if (demoMode === "band-problem-change") {
      const change = setTimeout(() => setProblem("updateToSync"), 12000);
      return () => clearTimeout(change);
    }
    if (demoMode !== "band-toggle") return;
    const show = setTimeout(() => setProblem("serverUnreachable"), 8000);
    const clear = setTimeout(() => setProblem(null), 16000);
    return () => { clearTimeout(show); clearTimeout(clear); };
  }, []);
  return problem;
}

// Stands in for messages queued on this phone while the server can't be reached.
export const waitingToSend = demoMode === "sheet-forget-waiting" ? 2 : 0;
