// The exit round: how main learns whether every workspace renderer can lose
// its set-aside drafts before a quit or an update install.
//
// Set-aside drafts live only in renderer memory, so main asks every live
// workspace window before any quit proceeds or quitAndInstall runs. Each
// renderer answers for itself: clear (nothing at stake, or the user
// confirmed), hold (its recovery dialog owns the decision), or cancel (the
// user went back). The round proceeds only when every participant is clear.
// A window that opens mid-round is enrolled; one that closes leaves.
//
// A participant that never answers may be busy, not dead, and no deadline
// tells those apart. So silence never counts as safe: when the ACK window
// elapses with a silent participant, main asks the USER, with the loss
// named. Only that explicit decision proceeds over silence, and only for the
// windows the dialog covered.

export type ExitKind = "quit" | "update";
export type ExitRoundDecision = "clear" | "hold" | "cancel";
export type ExitRoundOutcome = "proceed" | "cancelled" | "forced";
export type ExitRoundMessage =
  | { kind: "request"; roundId: number; exit: ExitKind }
  | { kind: "proceed"; roundId: number }
  | { kind: "cancelled"; roundId: number };

// Bounds a silent renderer's ACK, never the user's decision — an answering
// renderer resumes or holds within milliseconds.
const QUIT_ASK_TIMEOUT_MS = 3_000;

// Which renderers answer for the quit. Not every window runs the workspace:
// the PDF export creates a hidden, preload-less one, and asking IT about
// set-aside drafts answers nothing while the user sees an "isn't responding"
// dialog over drafts that were fully available. So the workspace windows are
// tracked at creation, never guessed from a live-window list.
type WorkspaceWindowRegistry<W> = {
  track(window: W): W;
  forget(window: W): void;
  live(): W | undefined;
  // Every live workspace window. The force-quit path destroys them, so a
  // renderer that wakes cannot veto a decision the user already made.
  allLive(): readonly W[];
  // The live windows whose renderer is running and can answer an exit
  // round. A crashed renderer holds no drafts and cannot answer, so asking
  // it would only put "dohc isn't responding" in front of the person.
  answering(): readonly W[];
};

export function createWorkspaceWindowRegistry<W>(
  isDestroyed: (window: W) => boolean,
  isRendererGone: (window: W) => boolean,
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
    answering() {
      return [...windows].filter((window) => !isDestroyed(window) && !isRendererGone(window));
    },
  };
}

export function createExitRounds<Participant>(options: {
  // The windows that can answer right now.
  participants(): readonly Participant[];
  participantId(participant: Participant): number;
  send(participant: Participant, message: ExitRoundMessage): void;
  // Main-side dialog for a participant that never answered. Resolves true
  // only when the user explicitly chose to quit or install anyway.
  confirmProceed(kind: ExitKind): Promise<boolean>;
  timeoutMs?: number;
}) {
  const timeoutMs = options.timeoutMs ?? QUIT_ASK_TIMEOUT_MS;
  interface Round {
    readonly id: number;
    readonly kind: ExitKind;
    readonly members: Map<number, Participant>;
    readonly replies: Map<number, "clear" | "hold">;
    timer: ReturnType<typeof setTimeout> | null;
    // The participants the open dialog named; null while no dialog is up.
    covered: Set<number> | null;
    // The silent participants a "quit anyway" decided over: the ones the
    // force path may destroy.
    readonly forced: Set<number>;
    // The user chose Wait on a quit: the round stays vetoed and does not
    // prompt again until the user asks to quit once more.
    waited: boolean;
    readonly resolve: (outcome: ExitRoundOutcome) => void;
    readonly outcome: Promise<ExitRoundOutcome>;
  }
  let sequence = 0;
  let current: Round | null = null;
  // The members of the last round that proceeded, held until the exit
  // it approved either happens or is retracted. A round is not `current`
  // once settled, but a window that enrolled late still holds its intent.
  let proceeded: { readonly id: number; readonly members: readonly Participant[] } | null = null;
  // The windows a forced quit may destroy: exactly the ones the user's
  // "quit anyway" dialog covered. A window that answered clear before the
  // dialog can capture another draft after it; it is never destroyed under
  // a decision that predates its work.
  let forcedParticipants: readonly Participant[] = [];

  const silent = (round: Round) =>
    [...round.members.keys()].filter((id) => !round.replies.has(id));
  const allClear = (round: Round) =>
    [...round.members.keys()].every((id) => round.replies.get(id) === "clear");

  function settle(round: Round, outcome: ExitRoundOutcome): void {
    if (current !== round) return;
    current = null;
    if (round.timer) clearTimeout(round.timer);
    if (outcome === "proceed") {
      proceeded = { id: round.id, members: [...round.members.values()] };
    }
    for (const [id, participant] of round.members) {
      // A forced window is destroyed without a message; every other member
      // hears the outcome and unloads through its own guard.
      if (outcome === "forced" && round.forced.has(id)) continue;
      options.send(participant, {
        kind: outcome === "cancelled" ? "cancelled" : "proceed",
        roundId: round.id,
      });
    }
    round.resolve(outcome);
  }

  // Proceeds only when nothing is still being decided: every member clear
  // and no dialog up. While the dialog is open its answer is authoritative
  // for the windows it covered, so a member leaving cannot settle behind it.
  function settleIfClear(round: Round): void {
    if (current !== round || round.covered) return;
    if (!allClear(round)) return;
    // Wait is not authorization: a quit the user chose to wait on stays
    // vetoed even once everyone is clear, until the user asks again.
    if (round.waited) return;
    const forced = [...round.members.entries()].filter(([id]) => round.forced.has(id));
    if (round.kind === "quit" && forced.length > 0) {
      forcedParticipants = forced.map(([, participant]) => participant);
      settle(round, "forced");
      return;
    }
    settle(round, "proceed");
  }

  function armTimer(round: Round): void {
    if (round.timer) clearTimeout(round.timer);
    round.timer = null;
    // The user chose Wait: no prompt until they ask to quit again, even for
    // a window that opens or loads meanwhile.
    if (round.waited || silent(round).length === 0) return;
    const timer = setTimeout(() => {
      round.timer = null;
      escalate(round);
    }, timeoutMs);
    timer.unref?.();
    round.timer = timer;
  }

  function check(round: Round): void {
    if (current !== round) return;
    settleIfClear(round);
    if (current !== round) return;
    // Every participant answered: the held ones own the decision now.
    if (silent(round).length === 0 && round.timer) {
      clearTimeout(round.timer);
      round.timer = null;
    }
  }

  function escalate(round: Round): void {
    if (current !== round || silent(round).length === 0) return;
    // The dialog is about the windows that have not answered. Its answer
    // decides exactly those; a window enrolled while it is up, or one that
    // already answered for itself, is not covered and keeps its own say.
    const covered = new Set(silent(round));
    round.covered = covered;
    void options.confirmProceed(round.kind).then((proceed) => {
      if (current !== round || round.covered !== covered) return;
      round.covered = null;
      if (!proceed) {
        // Waiting keeps the drafts. An install is refused outright. A quit
        // stays vetoed with no further prompt: the user said wait, and the
        // silent window can still answer. The next explicit quit asks
        // again through `begin`.
        if (round.kind === "update") settle(round, "cancelled");
        else round.waited = true;
        return;
      }
      // The user decided over the covered windows: they count as clear, and
      // a quit destroys them so a renderer that wakes cannot veto it.
      for (const id of covered) {
        if (!round.members.has(id)) continue;
        round.replies.set(id, "clear");
        if (round.kind === "quit") round.forced.add(id);
      }
      settleIfClear(round);
      // Anyone else must still answer: silence elsewhere goes back to the
      // user, and a hold owns itself.
      if (current === round) armTimer(round);
    });
  }

  function ask(round: Round, participant: Participant): void {
    options.send(participant, { kind: "request", roundId: round.id, exit: round.kind });
  }

  return {
    current(): { roundId: number; kind: ExitKind } | null {
      return current ? { roundId: current.id, kind: current.kind } : null;
    },

    // Starts a round, or joins the one already asking the same question. A
    // different question supersedes: the older round is cancelled so two
    // exits never compete.
    begin(kind: ExitKind): {
      roundId: number;
      outcome: Promise<ExitRoundOutcome>;
      created: boolean;
    } {
      if (current && current.kind !== kind) settle(current, "cancelled");
      if (current) {
        // Asking again lifts a Wait: the user now wants the exit, so an
        // all-clear round proceeds and a silent window is asked once more.
        const round = current;
        round.waited = false;
        for (const id of silent(round)) ask(round, round.members.get(id)!);
        settleIfClear(round);
        if (current === round && !round.covered) armTimer(round);
        return { roundId: round.id, outcome: round.outcome, created: false };
      }
      const { promise, resolve } = Promise.withResolvers<ExitRoundOutcome>();
      const round: Round = {
        id: ++sequence,
        kind,
        members: new Map(),
        replies: new Map(),
        timer: null,
        covered: null,
        forced: new Set(),
        waited: false,
        resolve,
        outcome: promise,
      };
      for (const participant of options.participants()) {
        round.members.set(options.participantId(participant), participant);
      }
      current = round;
      if (round.members.size === 0) {
        // Nothing rendered means nothing to lose.
        settle(round, "proceed");
      } else {
        for (const participant of round.members.values()) ask(round, participant);
        armTimer(round);
      }
      return { roundId: round.id, outcome: promise, created: true };
    },

    // An answer counts only from a participant of the current round. Returns
    // whether a round consumed it.
    answer(senderId: number, roundId: number, decision: ExitRoundDecision): boolean {
      const round = current;
      if (!round || round.id !== roundId || !round.members.has(senderId)) return false;
      if (decision === "cancel") {
        // A window that went back cancels the round outright, dialog or not:
        // the user in that window made a decision too.
        settle(round, "cancelled");
        return true;
      }
      round.replies.set(senderId, decision);
      // While the dialog is up it is authoritative for the windows it named;
      // their late replies are recorded but settle nothing, and a newcomer's
      // reply waits for the dialog as well. Nothing proceeds behind a
      // question the user is still reading.
      check(round);
      return true;
    },

    // A window that opened while a round is pending has work the round
    // never covered: it answers like everyone else. Enrolling twice (at
    // creation and again once loaded) re-sends the request to a renderer
    // that could not hear the first one.
    enroll(participant: Participant): void {
      const round = current;
      if (!round) return;
      const id = options.participantId(participant);
      if (!round.members.has(id)) round.members.set(id, participant);
      if (round.replies.has(id)) return;
      ask(round, participant);
      if (!round.covered && !round.timer) armTimer(round);
    },

    remove(participantId: number): void {
      const round = current;
      if (!round || !round.members.has(participantId)) return;
      round.members.delete(participantId);
      round.replies.delete(participantId);
      round.covered?.delete(participantId);
      round.forced.delete(participantId);
      // A round emptied while its dialog is up still waits for the user's
      // answer: with nothing left to ask, "wait" refuses an install and
      // leaves a quit vetoed, and "proceed" carries on with nobody to force.
      check(round);
    },

    // The windows the last forced quit covered; the force path destroys
    // exactly these. Consumed once.
    takeForcedParticipants(): readonly Participant[] {
      const taken = forcedParticipants;
      forcedParticipants = [];
      return taken;
    },

    // A proceeded round whose exit then did not happen (the updater refused
    // or failed): every member of that round, including one enrolled after
    // it began, drops the intent it claimed for it, so the next ordinary
    // close is not labelled a restart.
    retract(roundId: number): void {
      if (proceeded?.id !== roundId) return;
      const members = proceeded.members;
      proceeded = null;
      for (const participant of members) {
        options.send(participant, { kind: "cancelled", roundId });
      }
    },
  };
}

// The approval latch for app.quit(): before-quit proceeds only when a round
// approved it. The update-install path approves before quitAndInstall; a
// refused install revokes.
export function createQuitGuard(options: {
  // Starts the round that decides this quit.
  ask: () => void;
  quit: () => void;
  // The explicit "quit anyway" over a silent renderer. A renderer that wakes
  // before its window closes runs beforeunload knowing nothing of that
  // dialog, so it would veto the exit and open a second warning while the
  // guard stays approved forever. The force path makes the decision stick.
  forceQuit: () => void;
}) {
  let approved = false;
  return {
    // Returns "proceed" when the quit is already approved (main must let it
    // run) and "asked" when it was intercepted and the round began.
    beforeQuit(event: { preventDefault(): void }): "proceed" | "asked" {
      if (approved) return "proceed";
      event.preventDefault();
      options.ask();
      return "asked";
    },
    // An approval is for the quit it was granted for. If that quit was
    // vetoed, the approval must not outlive it, or the next quit proceeds
    // without asking.
    hold(): void {
      approved = false;
    },
    resume(): void {
      approved = true;
      options.quit();
    },
    force(): void {
      approved = true;
      options.forceQuit();
    },
    approve(): void {
      approved = true;
    },
    revoke(): void {
      approved = false;
    },
  };
}
