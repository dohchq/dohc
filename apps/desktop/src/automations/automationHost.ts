import {
  AUTOMATION_COMPUTER_LABEL_MAX_CHARS,
  AUTOMATION_INSTALL_ID_MAX_CHARS,
  isNoticeLine,
  type RelayAutomationComputer,
  type RelayAutomationHost,
} from "@dohc/workspace-contracts/relay";
import { readSyncHistory } from "../workspaces/syncHistory";

// Which of the owner's computers runs a synced workspace's schedules
// (ADR 0012). The relay records one host per workspace. This computer runs
// them while the last host it read names it and no handover is under way.
// It reads the host when the workspace opens, when the relay answers again
// after a read failed, and before each scheduler step or after each sync
// pull once its copy is a minute old. Offline, or signed in to another
// account, it keeps its copy, across restarts too. With schedules or Group
// triggers to run and no host recorded, it claims the host. When the owner
// moves the schedules to another computer, this one steps them one last
// time and reports how far it ran, so the new host starts after it.
//
// The host is also the only computer that watches the workspace's Groups,
// so the engine claims each Group message there. Before it releases, its
// engine stops them, and the release carries what the next host needs:
// the messages this host and earlier ones already decided. The new host
// takes that before it watches, and claims each stored message nobody
// decided, so each Group message starts its automations exactly once. While a
// handover waits, every computer that has the workspace open reads the host
// again on a short timer, so the new host starts soon after the release and
// the old one retries a release that did not go through.

/** Before a step, a copy read longer ago than this is read again. */
export const HOST_FRESH_MS = 60_000;
/**
 * While a handover waits, the host is read again after this long, then
 * after twice as long each time up to HANDOVER_READ_MAX_MS: at most two
 * reads a minute, for a handover whose old host stays off for days.
 */
export const HANDOVER_READ_FIRST_MS = 5_000;
export const HANDOVER_READ_MAX_MS = 30_000;

/** A relay answer, or null when this computer cannot ask as the workspace's owner. */
export type HostAnswer = { status: number; body: unknown } | null;

export type HostRequest =
  | { action: "check-in"; body: { installId: string; label: string; claim: boolean } }
  | {
    action: "release";
    // `groups` is the engine's Group handover, carried to the next host
    // unread; `groupsWatched` is the host generation at which it last
    // watched its Group subscriptions.
    body: { installId: string; generation: number; releasedThroughMs: number; groups: unknown; groupsWatched: number; reach: unknown };
  };

/**
 * What a computer that hands over reports: how far its schedules ran, its
 * Group handover, and the generation it last watched its Group
 * subscriptions at.
 */
export interface FinishedHere {
  throughMs: number;
  groups: unknown;
  groupsWatched: number;
  /** This computer's reach verdicts, or null when it could not read them. */
  reach: unknown;
}

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
  /**
   * This computer became the host, starting after `startAfterMs`, or at now
   * when null but never at or before `floorMs`, the host's recorded progress.
   */
  startedHere(workspaceId: string, startAfterMs: number | null, floorMs: number | null): void;
  /**
   * Whether this computer runs the workspace's automations may have
   * changed: its copy of the host changed, or a handover ended.
   */
  hostChanged(workspaceId: string): void;
  /**
   * Before this computer hands over: stops its Group subscriptions, then
   * steps the workspace's schedules one last time. Resolves with the time
   * it ran through and the Group handover, or null to try again at the next
   * read. `stillHandingOver` answers whether the owner has not called this
   * handover off since, from the last host read.
   */
  finishHere(workspaceId: string, stillHandingOver: () => boolean): Promise<FinishedHere | null>;
  logError(workspaceId: string, error: unknown): void;
  /** A clock that never steps backwards, for how old a copy is. */
  monotonicMs?(): number;
  /** The timer that reads the host again while a handover waits; a test drives it. */
  setTimer?(wake: () => void, delayMs: number): unknown;
  clearTimer?(timer: unknown): void;
}

interface HostState {
  host: RelayAutomationHost | null | undefined;
  readAtMs: number | null;
  /** The last read or handover got no answer: try again when the relay answers. */
  retry: boolean;
  reading: Promise<void> | null;
  /** This computer has schedules or Group triggers to run, so a read claims an unrecorded host. */
  claims: boolean;
  handingOver: boolean;
  /** Work this computer admitted as host that has not finished yet. */
  held: Set<Promise<void>>;
  /**
   * The newest host generation this computer acted on. An answer that
   * names an older one, such as a check-in that was still out when
   * settings chose another computer, is stale and changes nothing.
   */
  generation: number;
  /**
   * The workspace is open. A closed one keeps its state while admitted
   * work still runs, so a reopen finds the same holds and a handover still
   * waits for them; the state goes when the last hold ends.
   */
  open: boolean;
  /** Resolves when the state goes, so nothing waits on its holds after. */
  gone: Promise<void>;
  forget: () => void;
  /** The next read while a handover waits, and how long it waits. */
  handoverTimer: unknown;
  handoverDelayMs: number;
  /** A read failed while this synced workspace named no host, and hostChanged said so once. */
  failedUnnamed: boolean;
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

/**
 * A relay request that got no answer: the network or the relay is down, or
 * the request ran out of time. dohc expects this offline, so it is not an error.
 */
export function relayUnreachable(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && error.name === "TimeoutError");
}

/** The host from a relay answer, or undefined when the answer is not one. */
export function hostOfAnswer(answer: { status: number; body: unknown }): RelayAutomationHost | null | undefined {
  const { body } = answer;
  if (answer.status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const { ok, host } = body as { ok?: unknown; host?: unknown };
  if (ok !== true) return undefined;
  return host === null ? null : isHost(host) ? host : undefined;
}

/** The owner's computers from a relay answer, or undefined when the answer is not one. */
export function computersOfAnswer(answer: { status: number; body: unknown }): RelayAutomationComputer[] | undefined {
  const computers = answer.status === 200 && answer.body && typeof answer.body === "object"
    ? (answer.body as { computers?: unknown }).computers
    : undefined;
  if (!Array.isArray(computers)) return undefined;
  const valid = computers.every((computer: unknown) => {
    if (!computer || typeof computer !== "object") return false;
    const { installId, kind, label, lastSeenMs } = computer as Record<string, unknown>;
    return isNoticeLine(installId, AUTOMATION_INSTALL_ID_MAX_CHARS) &&
      (kind === "computer" || kind === "server") &&
      isNoticeLine(label, AUTOMATION_COMPUTER_LABEL_MAX_CHARS) &&
      typeof lastSeenMs === "number" && Number.isSafeInteger(lastSeenMs) && lastSeenMs >= 0;
  });
  return valid
    ? (computers as RelayAutomationComputer[]).map(({ installId, kind, label, lastSeenMs }) => ({ installId, kind, label, lastSeenMs }))
    : undefined;
}

/** A computer name the relay takes: printable, trimmed, and bounded. */
export function computerLabel(hostName: string): string {
  const printable = hostName.replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  const label = [...printable].slice(0, AUTOMATION_COMPUTER_LABEL_MAX_CHARS).join("").trim();
  return label.length > 0 ? label : "This computer";
}

type HostedWorkspace = { remote?: unknown; shareView?: unknown; rootPath: string } | null;

/**
 * The automation host generation this computer runs a workspace at, or null
 * when it is not the host. For a synced workspace, `relayGeneration`
 * answers from the relay's record. One that does not sync has this
 * computer as its host, at generation 0, only when its folder says it
 * never synced: this is its only computer. A workspace shared with this
 * person is never theirs to run.
 */
export async function automationHostGeneration(
  workspace: HostedWorkspace,
  relayGeneration: () => number | null | Promise<number | null>,
): Promise<number | null> {
  if (workspace === null || workspace.shareView !== undefined) return null;
  if (workspace.remote !== undefined) return await relayGeneration();
  return (await readSyncHistory(workspace.rootPath)) === "never-synced" ? 0 : null;
}

/** Whether this computer is a workspace's automation host; see automationHostGeneration. */
export async function isAutomationHost(
  workspace: HostedWorkspace,
  relayNamesThis: () => boolean | Promise<boolean>,
): Promise<boolean> {
  return (await automationHostGeneration(workspace, async () => ((await relayNamesThis()) ? 0 : null))) !== null;
}

export function createAutomationHosts(dependencies: AutomationHostsDependencies) {
  const monotonicMs = dependencies.monotonicMs ?? (() => performance.now());
  const setTimer = dependencies.setTimer ?? ((wake: () => void, delayMs: number) => setTimeout(wake, delayMs));
  const clearTimer = dependencies.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const states = new Map<string, HostState>();

  const runsOn = (host: RelayAutomationHost | null | undefined) =>
    host?.installId === dependencies.installId() && host.handoverFrom === null;

  function apply(workspaceId: string, state: HostState, host: RelayAutomationHost | null): void {
    // No host is generation 0; the relay never records one again after that.
    const generation = host?.generation ?? 0;
    if (generation < state.generation) return;
    state.generation = generation;
    const before = state.host;
    state.host = host;
    state.readAtMs = monotonicMs();
    const changed = JSON.stringify(before) !== JSON.stringify(host);
    if (changed) dependencies.store(workspaceId, host);
    if (runsOn(host) && !runsOn(before)) {
      // A release since this computer's last copy says where the last host stopped.
      const released = host?.releasedThroughMs ?? null;
      dependencies.startedHere(workspaceId, released !== (before?.releasedThroughMs ?? null) ? released : null, released);
    }
    if (host !== null && host.handoverFrom === dependencies.installId()) void handOver(workspaceId, state, host);
    if (changed) dependencies.hostChanged(workspaceId);
    // Another handover starts its reads short again.
    followHandover(workspaceId, state, changed);
  }

  /**
   * Keeps one timer that reads the host again while the open workspace's
   * copy shows a handover, and none otherwise. The read skips the freshness
   * check, and its answer goes through apply like any other.
   */
  function followHandover(workspaceId: string, state: HostState, restart = false): void {
    const waits = state.open && (state.host?.handoverFrom ?? null) !== null && dependencies.synced(workspaceId);
    if (!waits || restart) {
      if (state.handoverTimer !== null) clearTimer(state.handoverTimer);
      state.handoverTimer = null;
      state.handoverDelayMs = HANDOVER_READ_FIRST_MS;
    }
    if (!waits || state.handoverTimer !== null) return;
    state.handoverTimer = setTimer(() => {
      state.handoverTimer = null;
      if (states.get(workspaceId) !== state) return;
      state.handoverDelayMs = Math.min(state.handoverDelayMs * 2, HANDOVER_READ_MAX_MS);
      void refresh(workspaceId, state).finally(() => followHandover(workspaceId, state));
    }, state.handoverDelayMs);
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
          failedUnnamed(workspaceId, state);
          return;
        }
        const host = hostOfAnswer(answer);
        if (host === undefined) throw new Error(`The relay answered the automation host check-in with ${answer.status}.`);
        state.retry = false;
        state.failedUnnamed = false;
        apply(workspaceId, state, host);
      } catch (error) {
        state.retry = true;
        dependencies.logError(workspaceId, error);
        failedUnnamed(workspaceId, state);
        return;
      }
      // Schedules arrived while a read without a claim was out: claim now.
      if (claim || !state.claims || state.host !== null) return;
    }
  }

  /**
   * A read failed while this synced workspace names no host, as when sync
   * just turned on: host work that kept its state while the read was out
   * decides again now, with no host confirmed. Said once until a read
   * answers, so the reads it starts do not repeat it.
   */
  function failedUnnamed(workspaceId: string, state: HostState): void {
    if (state.failedUnnamed || (state.host ?? null) !== null || !dependencies.synced(workspaceId)) return;
    state.failedUnnamed = true;
    dependencies.hostChanged(workspaceId);
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
    // False once the workspace closed or the owner changed the host again:
    // this handover is over.
    const stillHandingOver = () => {
      const current = state.host;
      return states.get(workspaceId) === state &&
        current?.generation === host.generation &&
        current.handoverFrom === dependencies.installId();
    };
    try {
      // Work admitted while this computer was host finishes first; once
      // the handover began, stillRuns and hold admit nothing new.
      while (state.held.size > 0 && states.get(workspaceId) === state) {
        await Promise.race([Promise.all([...state.held]), state.gone]);
      }
      if (!stillHandingOver()) return;
      const finished = await dependencies.finishHere(workspaceId, stillHandingOver);
      // Called off while this computer finished: there is nothing to release.
      if (!stillHandingOver()) return;
      if (finished === null) {
        state.retry = true;
        return;
      }
      const answer = await dependencies.send(workspaceId, {
        action: "release",
        body: {
          installId: dependencies.installId(),
          generation: host.generation,
          releasedThroughMs: finished.throughMs,
          groups: finished.groups,
          groupsWatched: finished.groupsWatched,
          reach: finished.reach,
        },
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
      // A handover the owner called off leaves this computer the host again.
      dependencies.hostChanged(workspaceId);
    }
    if (reread) await refresh(workspaceId, state);
  }

  return {
    /** A workspace opened. A synced one reads its host now. Opening again changes nothing. */
    open(workspaceId: string): void {
      const kept = states.get(workspaceId);
      if (kept) {
        // Opening an open workspace again changes nothing.
        if (kept.open) return;
        kept.open = true;
        if (dependencies.synced(workspaceId)) void refresh(workspaceId, kept);
        followHandover(workspaceId, kept);
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
        generation: stored !== null && isHost(stored) ? stored.generation : 0,
        open: true,
        gone: Promise.resolve(),
        forget: () => undefined,
        handoverTimer: null,
        handoverDelayMs: HANDOVER_READ_FIRST_MS,
        failedUnnamed: false,
      };
      state.gone = new Promise<void>((resolve) => {
        state.forget = () => {
          if (states.get(workspaceId) === state) states.delete(workspaceId);
          resolve();
        };
      });
      states.set(workspaceId, state);
      if (dependencies.synced(workspaceId)) void refresh(workspaceId, state);
      // A handover the kept copy shows is followed from the start.
      followHandover(workspaceId, state);
    },

    close(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state) return;
      state.open = false;
      followHandover(workspaceId, state);
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

    /** The host generation this computer runs at when stillRuns, or null. */
    runsAt(workspaceId: string): number | null {
      const state = states.get(workspaceId);
      return state?.open === true && !state.handingOver && runsOn(state.host) ? state.host?.generation ?? null : null;
    },

    /**
     * For Group triggers: records this computer as the host when the relay
     * names none, as runsHere does for schedules. It reads only while this
     * computer knows no host for a synced workspace, so once a host is named
     * it answers at once, and a slow relay holds up only a computer that
     * has not learned one yet. After such a read failed it waits for
     * nothing: the next sync pull reads again. A workspace that does not
     * sync reads nothing, and claims the host at its first read once it syncs.
     */
    async admit(workspaceId: string): Promise<void> {
      const state = states.get(workspaceId);
      if (!state?.open) return;
      state.claims = true;
      if ((state.host ?? null) !== null || state.failedUnnamed) return;
      if (dependencies.synced(workspaceId)) await refresh(workspaceId, state);
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

    /**
     * The relay answered a read, choose, or take-over from settings: act on
     * the host it names. Answers the host this computer holds after, which
     * stays the newer one when the answer is stale.
     */
    learned(workspaceId: string, host: RelayAutomationHost | null): RelayAutomationHost | null {
      const state = states.get(workspaceId);
      if (!state) return host;
      apply(workspaceId, state, host);
      // An older answer changes nothing: the host already acted on stands.
      return state.host === undefined ? host : state.host;
    },

    /**
     * A sync pass reached the relay: read again if the last read or handover
     * did not, or once the copy is a minute old.
     */
    relayAnswered(workspaceId: string): void {
      const state = states.get(workspaceId);
      if (!state) return;
      // A computer with no schedules reads nowhere else, so this is where it
      // learns that the owner chose it.
      const stale = state.readAtMs === null || monotonicMs() - state.readAtMs > HOST_FRESH_MS;
      if (state.retry || stale) void refresh(workspaceId, state);
    },
  };
}

export type AutomationHosts = ReturnType<typeof createAutomationHosts>;
