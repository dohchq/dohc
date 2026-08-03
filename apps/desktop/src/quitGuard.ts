// The quit-ask state machine (#567 / #579 review, r10 + r11), extracted so
// the busy-renderer promise is a tested fact, not main-process wiring.
//
// Set-aside drafts live only in renderer memory, so main asks the renderer
// before any quit proceeds. The renderer answers promptly: resume (nothing at
// stake, or the user confirmed) or hold (its recovery dialog owns the
// decision). When no answer comes inside the ACK window, the renderer may be
// BUSY, not dead — and a busy renderer's drafts still count (#579 review,
// r11). So the timeout never quits by itself: it asks the USER, main-side,
// with the loss named. Only an explicit decision force-quits.
export type QuitGuard = {
  // Returns "proceed" when the quit is already approved (main must let it
  // run) and "asked" when it was intercepted and the renderer was asked.
  beforeQuit(event: { preventDefault(): void }): "proceed" | "asked";
  // The renderer's answers to the ask.
  hold(): void;
  resume(): void;
  // The update-install path decides renderer-side BEFORE quitAndInstall, so
  // the quit it starts is pre-approved; a refused install revokes it.
  approve(): void;
  revoke(): void;
};

// Bounds a silent renderer's ACK, never the user's decision — an answering
// renderer resumes or holds within milliseconds.
export const QUIT_ASK_TIMEOUT_MS = 3_000;

export function createQuitGuard(options: {
  askRenderer: () => void;
  // Main-side force-quit confirmation for a renderer that never answered.
  // Resolves true only when the user explicitly chose to quit anyway.
  confirmForceQuit: () => Promise<boolean>;
  quit: () => void;
  timeoutMs?: number;
}): QuitGuard {
  const timeoutMs = options.timeoutMs ?? QUIT_ASK_TIMEOUT_MS;
  let approved = false;
  let askTimer: ReturnType<typeof setTimeout> | null = null;
  const clearAskTimer = (): void => {
    if (askTimer) {
      clearTimeout(askTimer);
      askTimer = null;
    }
  };
  return {
    beforeQuit(event) {
      if (approved) return "proceed";
      event.preventDefault();
      clearAskTimer();
      askTimer = setTimeout(() => {
        askTimer = null;
        void options.confirmForceQuit().then((quitAnyway) => {
          // A resume may have landed while the dialog was up (already
          // quitting), or a newer ask may own the flow — a stale answer
          // must not double-quit or hijack it. A hold that arrived
          // meanwhile shows the renderer's own dialog too; an explicit
          // "quit anyway" here still wins, because the user answered a
          // dialog that named the loss.
          if (!quitAnyway || approved || askTimer !== null) return;
          approved = true;
          options.quit();
        });
      }, timeoutMs);
      options.askRenderer();
      return "asked";
    },
    hold() {
      clearAskTimer();
    },
    resume() {
      clearAskTimer();
      approved = true;
      options.quit();
    },
    approve() {
      clearAskTimer();
      approved = true;
    },
    revoke() {
      approved = false;
    },
  };
}
