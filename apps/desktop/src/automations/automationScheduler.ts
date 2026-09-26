import { dueTimes, nextDue } from "@dohc/workspace-contracts/automation-schedule";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

type AutomationScheduleMark = Awaited<ReturnType<VersionedLiveAdapter["listAutomationScheduleMarks"]>>["marks"][number];
import type { ScheduledAutomation } from "./collectionAutomations";

// The one scheduler for every open workspace this computer runs schedules
// for. It keeps a single timer set for the earliest due time, at most 15
// minutes ahead, and never polls between. At each wake it claims the due
// times it reached, even late, and moves each schedule's mark past them.
//
// A due time this computer did not live through is skipped, not run: one
// in the 5 minutes before a workspace opened still runs, anything older is
// skipped, and so is anything between a suspend and its resume. When the
// wall clock and the monotonic clock disagree by more than 2 seconds, the
// wall clock was set, and everything after the last check is skipped: the
// clock never showed some of those times. A skipped span stays until every
// mark has passed it, so a failed step cannot run it later. A new
// automation, a changed schedule, or a switch-on starts at the time it
// happened, so nothing before it runs.

/** A due time up to this long before a workspace opened still runs. */
export const START_GRACE_MS = 5 * 60_000;
/** The timer never waits longer than this. */
export const MAX_TIMER_MS = 15 * 60_000;
/** A wall clock that moved this much more or less than the monotonic clock was set. */
export const CLOCK_JUMP_MS = 2_000;
/** The engine's bound on the due times one step claims. */
export const MAX_RUNS_PER_STEP = 100;

/** One workspace's schedules, as its Collection executor keeps them. */
export interface ScheduleSource {
  /** The enabled schedules, or null until the executor has read them. */
  schedules(): ScheduledAutomation[] | null;
  /** Null while the engine is not answering. */
  scheduleMarks(): Promise<AutomationScheduleMark[] | null>;
  /** The mark after the step, or null while the engine is not answering. */
  claimSchedule(input: {
    automationId: string;
    scheduleHash: string;
    run: number[];
    throughMs: number;
  }): Promise<AutomationScheduleMark | null>;
}

/** Where a workspace's schedules run. */
export interface ScheduleHost {
  /** Whether this computer runs the workspace's schedules now. It may ask the relay first. */
  runsHere(): Promise<boolean>;
  /**
   * Asked right before each claim, with nothing awaited in between: false
   * once something changed, such as the workspace starting to sync.
   */
  stillRuns(): boolean;
  /**
   * When it does not run them, whether to ask again within the timer's cap:
   * the owner can move a synced workspace's schedules to this computer.
   */
  asksAgain(): boolean;
}

export interface SchedulerClock {
  now(): number;
  /** Milliseconds from a clock that no one can set. */
  monotonic(): number;
  setTimer(wake: () => void, delayMs: number): unknown;
  clearTimer(timer: unknown): void;
}

export interface AutomationSchedulerOptions {
  clock: SchedulerClock;
  onError(context: string, error: unknown): void;
}

/** Wall time this computer did not live through: after `from`, up to and including `through`. */
export interface SkippedSpan {
  from: number;
  through: number;
}

/**
 * What one schedule's step claims: the due times to run and the mark's new
 * position, or null when nothing is due. Due times at or before
 * `coveredFrom` or the schedule's switch-on, or in a skipped span, are
 * skipped.
 */
export function planScheduleStep(
  schedule: ScheduledAutomation,
  mark: AutomationScheduleMark | undefined,
  nowMs: number,
  coveredFrom: number,
  skipped: readonly SkippedSpan[] = [],
): { run: number[]; throughMs: number } | null {
  if (mark === undefined || mark.scheduleHash !== schedule.scheduleHash) return { run: [], throughMs: nowMs };
  if (mark.throughMs >= nowMs) return null;
  const first = nextDue(schedule.trigger, mark.throughMs);
  if (first === null || first > nowMs) return null;
  const run: number[] = [];
  // Past the bound, the rest wait for the next step instead of being skipped.
  const collect = (after: number, until: number) => {
    if (after < until) run.push(...dueTimes(schedule.trigger, after, until, MAX_RUNS_PER_STEP - run.length));
    return run.length === MAX_RUNS_PER_STEP;
  };
  let from = Math.max(mark.throughMs, coveredFrom, schedule.enabledSince ?? coveredFrom);
  for (const span of [...skipped].sort((left, right) => left.from - right.from)) {
    if (from >= nowMs) break;
    if (span.through <= from) continue;
    if (collect(from, Math.min(span.from, nowMs))) return { run, throughMs: run.at(-1)! };
    from = span.through;
  }
  if (from < nowMs && collect(from, nowMs)) return { run, throughMs: run.at(-1)! };
  return { run, throughMs: nowMs };
}

interface Workspace {
  source: ScheduleSource;
  host: ScheduleHost;
  /** What the last step found host.runsHere to answer. */
  runs: boolean | null;
  /** The engine's marks by automation id, or null until read. */
  marks: Map<string, AutomationScheduleMark> | null;
  coveredFrom: number;
  /** Spans slept through or jumped over that some mark has not passed yet. */
  skipped: SkippedSpan[];
  /**
   * Set when this computer took over from another: a schedule it has no
   * mark for starts here instead of at now, once.
   */
  unmarkedFrom: number | null;
}

export class AutomationScheduler {
  private readonly workspaces = new Map<string, Workspace>();
  private timer: unknown = null;
  // The clocks at the last check, to find a wall clock that was set.
  private sample: { wall: number; monotonic: number } | null = null;
  private suspendedAt: number | null = null;
  private stepping: Promise<void> | null = null;
  // Steps run one at a time, including a handover's last one.
  private queue: Promise<unknown> = Promise.resolve();
  private stepAgain = false;
  private disposed = false;

  constructor(private readonly options: AutomationSchedulerOptions) {}

  /** A workspace opened. Its schedules start with the start grace. */
  add(workspaceId: string, source: ScheduleSource, host: ScheduleHost): void {
    this.workspaces.set(workspaceId, {
      source,
      host,
      runs: null,
      marks: null,
      coveredFrom: this.options.clock.now() - START_GRACE_MS,
      skipped: [],
      unmarkedFrom: null,
    });
    this.wake();
  }

  /**
   * This computer became the workspace's host. After another computer
   * released through `startAfterMs`, due times after it run here, less
   * what this computer did not live through. When this computer's clock
   * is behind, nothing runs until it passes the release. With no release,
   * the schedules start at now.
   */
  startedHere(workspaceId: string, startAfterMs: number | null): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const now = this.options.clock.now();
    workspace.coveredFrom = startAfterMs === null ? now : Math.max(workspace.coveredFrom, startAfterMs);
    workspace.unmarkedFrom = startAfterMs === null ? null : workspace.coveredFrom;
    this.wake();
  }

  /**
   * The owner moved the workspace's schedules to another computer: step
   * them here one last time. Resolves with the time through which every
   * due time ran or was skipped, or null when the step stopped short.
   */
  finishHere(workspaceId: string): Promise<number | null> {
    return this.serial(async () => {
      const workspace = this.workspaces.get(workspaceId);
      if (!workspace || this.disposed) return null;
      try {
        // Every schedule steps through one cutoff, so the release is true
        // for each of them: one past the engine's per-step bound steps again.
        const cutoff = this.options.clock.now();
        for (;;) {
          const through = await this.stepWorkspace(workspace, cutoff, true);
          if (through === null || through >= cutoff) return through;
        }
      } catch (error) {
        workspace.marks = null;
        this.options.onError(`finish the schedules in workspace "${workspaceId}"`, error);
        return null;
      }
    });
  }

  remove(workspaceId: string): void {
    if (this.workspaces.delete(workspaceId)) this.wake();
  }

  /**
   * Something that moves due times happened: a workspace's automations
   * changed, the screen unlocked, the system clock was set, or the engine
   * answers again. The step decides what ran and re-sets the timer.
   */
  wake(): void {
    if (this.disposed) return;
    if (this.stepping) {
      this.stepAgain = true;
      return;
    }
    this.stepping = this.serial(() => this.stepAll())
      .catch((error: unknown) => this.options.onError("step the schedules", error))
      .finally(() => {
        this.stepping = null;
        if (this.stepAgain) {
          this.stepAgain = false;
          this.wake();
        }
      });
  }

  /** The computer is going to sleep. Nothing wakes until it resumes. */
  suspended(): void {
    if (this.suspendedAt !== null) return;
    this.checkClock();
    this.suspendedAt = this.options.clock.now();
    this.clearTimer();
  }

  /**
   * The computer woke. Due times before it went to sleep run; those while it
   * slept are skipped. A resume without a suspend is left to the clock
   * check.
   */
  resumed(): void {
    const { clock } = this.options;
    if (this.suspendedAt !== null) {
      this.skip(this.suspendedAt, clock.now());
      this.suspendedAt = null;
      this.sample = { wall: clock.now(), monotonic: clock.monotonic() };
    }
    this.wake();
  }

  /** Resolves once no step is running or queued. */
  async idle(): Promise<void> {
    while (this.stepping) await this.stepping;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.workspaces.clear();
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private clearTimer(): void {
    if (this.timer !== null) this.options.clock.clearTimer(this.timer);
    this.timer = null;
  }

  private skip(from: number, through: number): void {
    if (through <= from) return;
    // A workspace this computer does not run has no marks to keep behind.
    // One whose first answer is still out keeps the span until it knows.
    for (const workspace of this.workspaces.values()) {
      if (workspace.runs !== false) workspace.skipped.push({ from, through });
    }
  }

  // When the wall clock moved apart from the monotonic clock since the last
  // check, it was set: skip everything after the last check.
  private checkClock(): void {
    const { clock } = this.options;
    const wall = clock.now();
    const monotonic = clock.monotonic();
    const last = this.sample;
    this.sample = { wall, monotonic };
    if (last !== null && Math.abs(wall - last.wall - (monotonic - last.monotonic)) > CLOCK_JUMP_MS) {
      this.skip(last.wall, wall);
    }
  }

  private async stepAll(): Promise<void> {
    this.clearTimer();
    this.checkClock();
    const now = this.options.clock.now();
    for (const [workspaceId, workspace] of [...this.workspaces]) {
      if (this.disposed) return;
      try {
        await this.stepWorkspace(workspace, now);
      } catch (error) {
        // A refused step can mean the engine lost its marks, as when its
        // store was rebuilt: read them again at the next step.
        workspace.marks = null;
        this.options.onError(`step the schedules in workspace "${workspaceId}"`, error);
      }
    }
    // A clock set while the step waited on the engine counts from here.
    this.checkClock();
    this.arm();
  }

  // Steps one workspace to `now`. Resolves with the time through which
  // every due time ran or was skipped, or null when the step stopped short.
  private async stepWorkspace(workspace: Workspace, now: number, handingOver = false): Promise<number | null> {
    const schedules = workspace.source.schedules();
    if (schedules === null) return null;
    if (schedules.length === 0) {
      workspace.skipped = [];
      return now;
    }
    if (!handingOver) {
      workspace.runs = await workspace.host.runsHere();
      if (!workspace.runs) {
        workspace.skipped = [];
        return null;
      }
    }
    if (workspace.marks === null) {
      const read = await workspace.source.scheduleMarks();
      // The engine is not answering. It wakes the scheduler when it does.
      if (read === null) return null;
      workspace.marks = new Map(read.map((mark) => [mark.automationId, mark]));
    }
    const marks = workspace.marks;
    // Sends one claim, planned from the schedule as it is right then: from
    // the checks to the send, nothing is awaited.
    const claim = async (
      automationId: string,
      plan: (schedule: ScheduledAutomation) => { run: number[]; throughMs: number } | null,
    ): Promise<AutomationScheduleMark | "nothing" | null> => {
      if (!handingOver && !workspace.host.stillRuns()) {
        workspace.runs = false;
        return null;
      }
      const schedule = workspace.source.schedules()?.find((current) => current.automationId === automationId);
      const step = schedule ? plan(schedule) : null;
      if (!schedule || step === null) return "nothing";
      const mark = await workspace.source.claimSchedule({ automationId, scheduleHash: schedule.scheduleHash, ...step });
      // Read the marks again once the engine answers.
      if (mark === null) workspace.marks = null;
      else marks.set(automationId, mark);
      return mark;
    };
    let through = now;
    for (const { automationId } of schedules) {
      if (workspace.unmarkedFrom !== null) {
        const from = workspace.unmarkedFrom;
        const adopted = await claim(automationId, (schedule) =>
          marks.get(automationId)?.scheduleHash === schedule.scheduleHash ? null : { run: [], throughMs: from });
        if (adopted === null) return null;
      }
      const claimed = await claim(automationId, (schedule) =>
        planScheduleStep(schedule, marks.get(automationId), now, workspace.coveredFrom, workspace.skipped));
      if (claimed === null) return null;
      if (claimed !== "nothing") through = Math.min(through, claimed.throughMs);
    }
    workspace.unmarkedFrom = null;
    // Every mark passed these spans, so nothing is left to skip in them.
    workspace.skipped = workspace.skipped.filter((span) => span.through > through);
    return through;
  }

  // The earliest due time after every mark, at most MAX_TIMER_MS ahead. No
  // timer when nothing is scheduled.
  private arm(): void {
    if (this.disposed || this.suspendedAt !== null) return;
    const { clock } = this.options;
    const now = clock.now();
    const latest = now + MAX_TIMER_MS;
    let wakeAt: number | null = null;
    for (const [workspaceId, workspace] of this.workspaces) {
      let schedules: ScheduledAutomation[];
      try {
        schedules = workspace.source.schedules() ?? [];
      } catch (error) {
        this.options.onError(`set the timer for the schedules in workspace "${workspaceId}"`, error);
        wakeAt = Math.min(wakeAt ?? latest, latest);
        continue;
      }
      if (schedules.length === 0) continue;
      if (!workspace.runs) {
        // Ask again within the cap whether the owner moved the schedules here.
        if (workspace.host.asksAgain()) wakeAt = Math.min(wakeAt ?? latest, latest);
        continue;
      }
      for (const schedule of schedules) {
        const mark = workspace.marks?.get(schedule.automationId);
        let next = latest;
        try {
          if (mark !== undefined && mark.scheduleHash === schedule.scheduleHash) {
            next = nextDue(schedule.trigger, Math.max(mark.throughMs, now)) ?? latest;
          }
        } catch (error) {
          // A mark the next-run module cannot follow: try again within the cap.
          this.options.onError(`set the timer for "${schedule.automationId}"`, error);
        }
        wakeAt = Math.min(wakeAt ?? next, next);
      }
    }
    if (wakeAt === null) return;
    const delay = Math.min(Math.max(wakeAt - now, 0), MAX_TIMER_MS);
    this.timer = clock.setTimer(() => {
      this.timer = null;
      this.wake();
    }, delay);
  }
}
