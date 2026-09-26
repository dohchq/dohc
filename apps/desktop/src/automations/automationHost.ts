import {
  AUTOMATION_COMPUTER_LABEL_MAX_CHARS,
  AUTOMATION_INSTALL_ID_MAX_CHARS,
  isNoticeLine,
  type RelayAutomationHost,
} from "@dohc/workspace-contracts/relay";

// Which of the owner's computers runs a synced workspace's schedules
// (ADR 0012). The relay records one host per workspace. This computer runs
// them while the last host it read names it and no handover is under way.
// It reads the host when the workspace opens, when the relay answers again
// after a read failed, and before each scheduler step once its copy is a
// minute old. Offline, or signed in to another account, it keeps its copy,
// across restarts too. With schedules to run and no host recorded, it
// claims the host. When the owner moves the schedules to another computer,
// this one steps them one last time and reports how far it ran, so the new
// host starts after it.

/** Before a step, a copy read longer ago than this is read again. */
export const HOST_FRESH_MS = 60_000;

/** A relay answer, or null when this computer cannot ask as the workspace's owner. */
export type HostAnswer = { status: number; body: unknown } | null;

export type HostRequest =
  | { action: "check-in"; body: { installId: string; label: string; claim: boolean } }
  | { action: "release"; body: { installId: string; generation: number; releasedThroughMs: number } };

export interface AutomationHostsDependencies {
  /** This computer's install id. */
  installId(): string;
  /** This computer's name, as the owner's settings show it. */
  label(): string;
  /** Whether the workspace syncs through a relay now. */
  synced(workspaceId: string): boolean;
  /** Sends one owner request for the workspace. Throws when no answer arrives. */
  send(workspaceId: string, request: HostRequest): Promise<HostAnswer>;
  /** The copy kept across restarts: absent before any read, null when the relay recorded no host. */
  stored(workspaceId: string): unknown;
  store(workspaceId: string, host: RelayAutomationHost | null): void;
  /** This computer became the host, starting after `startAfterMs` or at now when null. */
  startedHere(workspaceId: string, startAfterMs: number | null): void;
  /**
   * Steps the workspace's schedules one last time before this computer
   * hands over. Resolves with the time it ran through, or null to try
   * again at the next read.
   */
  finishHere(workspaceId: string): Promise<number | null>;
  logError(workspaceId: string, error: unknown): void;
  /** A clock that never steps backwards, for how old a copy is. */
  monotonicMs?(): number;
}

interface HostState {
  host: RelayAutomationHost | null | undefined;
  readAtMs: number | null;
  /** The last read or handover got no answer: try again when the relay answers. */
  retry: boolean;
  reading: Promise<void> | null;
  /** This computer has schedules to run, so a read claims an unrecorded host. */
  claims: boolean;
  handingOver: boolean;
  /** Work this computer admitted as host that has not finished yet. */
  held: Set<Promise<void>>;
  /**
   * The workspace is open. A closed one keeps its state while admitted
   * work still runs, so a reopen finds the same holds and a handover still
   * waits for them; the state goes when the last hold ends.
   */
  open: boolean;
  /** Resolves when the state goes, so nothing waits on its holds after. */
  gone: Promise<void>;
  forget: () => void;
}

function isHost(value: unknown): value is RelayAutomationHost {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Record<string, unknown>;
  const time = (entry: unknown) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  return Object.keys(host).length === 4 &&
    isNoticeLine(host.installId, AUTOMATION_INSTALL_ID_MAX_CHARS) &&
    time(host.generation) &&
    (host.handoverFrom === null || isNoticeLine(host.handoverFrom, AUTOMATION_INSTALL_ID_MAX_CHARS)) &&
    (host.releasedThroughMs === null || time(host.releasedThroughMs));
}

/** The host from a relay answer, or undefined when the answer is not one. */
export function hostOfAnswer(answer: { status: number; body: unknown }): RelayAutomationHost | null | undefined {
  const { body } = answer;
  if (answer.status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { ok, host } = body as { ok?: unknown; host?: unknown };
  if (ok !== true) return undefined;
  return host === null ? null : isHost(host) ? host : undefined;
}

/** A computer name the relay takes: printable, trimmed, and bounded. */
export function computerLabel(hostName: string): string {
  const printable = hostName.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const label = [...printable].slice(0, AUTOMATION_COMPUTER_LABEL_MAX_CHARS).join("").trim();
  return label.length > 0 ? label : "This computer";
}

export function createAutomationHosts(dependencies: AutomationHostsDependencies) {
  const monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
  const states = new Map<string, HostState>();

  const runsOn = (host: RelayAutomationHost | null | undefined) =>
    host?.installId === dependencies.installId() && host.handoverFrom === null;

  function apply(workspaceId: string, state: HostState, host: RelayAutomationHost | null): void {
    const before = state.host;
    state.host = host;
    state.readAtMs = monotonicMs();
    if (JSON.stringify(before) !== JSON.stringify(host)) dependencies.store(workspaceId, host);
    if (runsOn(host) && !runsOn(before)) {
      // A release since this computer's last copy says where the last host stopped.
      const released = host?.releasedThroughMs ?? null;
      dependencies.startedHere(workspaceId, released !== (before?.releasedThroughMs ?? null) ? released : null);
    }
    if (host !== null && host.handoverFrom === dependencies.installId()) void handOver(workspaceId, state, host);
  }

  async function read(workspaceId: string, state: HostState): Promise<void> {
    for (;;) {
      const claim = state.claims;
      try {
        const answer = await dependencies.send(workspaceId, {
          action: "check-in",
          body: { installId: dependencies.installId(), label: dependencies.label(), claim },
        });
        if (states.get(workspaceId) !== state) return;
        if (answer === null) {
          state.retry = true;
          return;
        }
        const host = hostOfAnswer(answer);
        if (host === undefined) throw new Error(`The relay answered the automation host check-in with ${answer.status}.`);
        state.retry = false;
        apply(workspaceId, state, host);
      } catch (error) {
        state.retry = true;
        dependencies.logError(workspaceId, error);
        return;
      }
      // Schedules arrived while a read without a claim was out: claim now.
      if (claim || !state.claims || state.host !== null) return;
    }
  }

  function refresh(workspaceId: string, state: HostState): Promise<void> {
    state.reading ??= read(workspaceId, state).finally(() => {
      state.reading = null;
    });
    return state.reading;
  }

  async function handOver(workspaceId: string, state: HostState, host: RelayAutomationHost): Promise<void> {
    if (state.handingOver) return;
    state.handingOver = true;
    let reread = false;
    try {
      // Work admitted while this computer was host finishes first; once
      // the handover began, stillRuns and hold admit nothing new.
      while (state.held.size > 0 && states.get(workspaceId) === state) {
        await Promise.race([Promise.all([...state.held]), state.gone]);
      }
      // The workspace closed, or the owner changed the host again, while
      // the held work ran: this handover is over.
      const current = state.host;
      if (
        states.get(workspaceId) !== state ||
        current?.generation !== host.generation ||
        current.handoverFrom !== dependencies.installId()
      ) {
        return;
      }
      const through = await dependencies.finishHere(workspaceId);
      if (states.get(workspaceId) !== state) return;
      if (through === null) {
        state.retry = true;
        return;
      }
      const answer = await dependencies.send(workspaceId, {
        action: "release",
        body: { installId: dependencies.installId(), generation: host.generation, releasedThroughMs: through },
      });
      if (states.get(workspaceId) !== state) return;
      if (answer === null) {
        state.retry = true;
        return;
      }
      const released = hostOfAnswer(answer);
      // 409: the owner changed the host again first. Read it and act on it.
      if (released === undefined && answer.status === 409) reread = true;
      else if (released === undefined) throw new Error(`The relay answered the automation host release with ${answer.status}.`);
      else apply(workspaceId, state, released);
    } catch (error) {
      state.retry = true;
      dependencies.logError(workspaceId, error);
    } finally {
      state.handingOver = false;
    }
    if (reread) await refresh(workspaceId, state);
  }

  return {
    /** A workspace opened. A synced one reads its host now. */
    open(workspaceId: string): void {
      const kept = states.get(workspaceId);
      if (kept) {
        kept.open = true;
        if (dependencies.synced(workspaceId)) void refresh(workspaceId, kept);
        return;
      }
      const stored = dependencies.stored(workspaceId);
      const state: HostState = {
        host: stored === null ? null : isHost(stored) ? stored : undefined,
        readAtMs: null,
        retry: false,
        reading: null,
        claims: false,
        handingOver: false,
        held: new Set(),
        open: true,
        gone: Promise.resolve(),
        forget: () => undefined,
      };
      state.gone = new Promise<void>((resolve) => {
        state.forget = () => {
          if (states.get(workspaceId) === state) states.delete(workspaceId);
          resolve();
        };
      });
      states.set(workspaceId, state);
      if (dependencies.synced(workspaceId)) void refresh(workspaceId, state);
    },

    close(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state) return;
      state.open = false;
      if (state.held.size === 0) state.forget();
    },

    /**
     * Before a step of the workspace's schedules: whether this computer runs
     * them. Reads the host first when the copy is a minute old, or when no
     * host is recorded and this computer has not claimed it yet.
     */
    async runsHere(workspaceId: string): Promise<boolean> {
      const state = states.get(workspaceId);
      if (!state?.open) return false;
      const stale = state.readAtMs === null || monotonicMs() - state.readAtMs > HOST_FRESH_MS;
      const unclaimed = state.host === null && !state.claims;
      state.claims = true;
      if (stale || unclaimed) await refresh(workspaceId, state);
      return runsOn(state.host);
    },

    /** Whether the last host read names this computer, with nothing awaited. */
    stillRuns(workspaceId: string): boolean {
      const state = states.get(workspaceId);
      return state?.open === true && !state.handingOver && runsOn(state.host);
    },

    /**
     * Admits one piece of host work, such as a relayed button press, while
     * this computer is the host as it last read. A handover waits until
     * every admitted piece calls its release. Null when this computer is
     * not the host, or a handover began: then run nothing.
     */
    hold(workspaceId: string): (() => void) | null {
      const state = states.get(workspaceId);
      if (!state?.open || state.handingOver || !runsOn(state.host)) return null;
      let release: () => void = () => undefined;
      const done = new Promise<void>((resolve) => { release = resolve; });
      state.held.add(done);
      return () => {
        state.held.delete(done);
        release();
        // A closed workspace's state goes with its last hold.
        if (!state.open && state.held.size === 0) state.forget();
      };
    },

    /** A sync pass reached the relay: read again if the last read or handover did not. */
    relayAnswered(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (state && (state.retry || state.readAtMs === null)) void refresh(workspaceId, state);
    },
  };
}

export type AutomationHosts = ReturnType<typeof createAutomationHosts>;
