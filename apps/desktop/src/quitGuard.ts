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

// Which renderer answers for the quit. Not every window runs the workspace:
// the PDF export creates a hidden, preload-less one, and asking IT about
// set-aside drafts answers nothing while the user sees an "isn't responding"
// dialog over drafts that were fully available (#579 review, r12). So the
// workspace windows are TRACKED at creation, never guessed from a live-window
// list.
export type WorkspaceWindowRegistry<W> = {
  track(window: W): W;
  forget(window: W): void;
  live(): W | undefined;
  // Every live workspace window. The force-quit path destroys them, so a
  // renderer that wakes cannot veto a decision the user already made
  // (#579 review, r15).
  allLive(): readonly W[];
};

export function createWorkspaceWindowRegistry<W>(
  isDestroyed: (window: W) => boolean,
): WorkspaceWindowRegistry<W> {
  const windows = new Set<W>();
  return {
    track(window) {
      windows.add(window);
      return window;
    },
    forget(window) {
      windows.delete(window);
    },
    live() {
      for (const window of windows) {
        if (!isDestroyed(window)) return window;
      }
      return undefined;
    },
    allLive() {
      return [...windows].filter((window) => !isDestroyed(window));
    },
  };
}

// The recovery re-check at the quit boundary (#579 review, r12). The renderer
// checks its own drafts before it asks for an install, and a reopen can set an
// edit aside in the gap between that check and the IPC handler — separate
// processes, and a queued render lands inside it. So main asks AGAIN at the
// moment it would approve the quit.
//
// Fail-closed: a renderer that does not answer inside the window counts as
// blocked. Refusing an install costs a retry; approving one destroys the only
// copy of the user's text.
export const RECOVERY_CHECK_TIMEOUT_MS = 2_000;

export type RecoveryChecker = {
  // True when unresolved set-aside drafts must stop the quit.
  ask(): Promise<boolean>;
  answer(requestId: number, blocked: boolean): void;
};

export function createRecoveryChecker(options: {
  // Sends the request to the renderer; returns false when there is no
  // renderer to ask (nothing rendered means nothing to lose).
  send: (requestId: number) => boolean;
  timeoutMs?: number;
}): RecoveryChecker {
  const timeoutMs = options.timeoutMs ?? RECOVERY_CHECK_TIMEOUT_MS;
  let sequence = 0;
  const pending = new Map<number, (blocked: boolean) => void>();
  const settle = (requestId: number, blocked: boolean): void => {
    const resolve = pending.get(requestId);
    if (!resolve) return;
    pending.delete(requestId);
    resolve(blocked);
  };
  return {
    ask() {
      const requestId = ++sequence;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(requestId, true), timeoutMs);
        timer.unref?.();
        pending.set(requestId, (blocked) => {
          clearTimeout(timer);
          resolve(blocked);
        });
        if (!options.send(requestId)) settle(requestId, false);
      });
    },
    answer(requestId, blocked) {
      settle(requestId, blocked);
    },
  };
}

export function createQuitGuard(options: {
  askRenderer: () => void;
  // Main-side force-quit confirmation for a renderer that never answered.
  // Resolves true only when the user explicitly chose to quit anyway.
  confirmForceQuit: () => Promise<boolean>;
  quit: () => void;
  // The explicit "quit anyway" answer, which an ordinary quit cannot deliver
  // (#579 review, r15). A renderer that wakes before its window closes runs
  // beforeunload knowing nothing of THIS dialog — no bypass, no approved ids
  // — so it vetoes the exit and opens a second warning, while the guard stays
  // approved forever. The user already decided over an unresponsive renderer;
  // this path makes that decision stick.
  forceQuit: () => void;
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
          options.forceQuit();
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
