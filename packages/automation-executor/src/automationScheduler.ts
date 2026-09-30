import { dueTimes, nextDue } from "@dohc/workspace-contracts/automation-schedule";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

type AutomationScheduleMark = Awaited<ReturnType<VersionedLiveAdapter["listAutomationScheduleMarks"]>>["marks"][number];
import type { ScheduledAutomation } from "./collectionAutomations";

// The one scheduler for every workspace this computer runs schedules for.
// It keeps a single timer set for the earliest due time, at most 15 minutes
// ahead, and never polls between. At each wake it claims the due times it
// reached, even late, and moves each schedule's mark past them. It keeps a
// record of each workspace's schedules and marks, so a workspace that is
// not open opens in the background when one of them is due.
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
/** One step looks at most this many due times; the rest wait for the next. */
export const MAX_DUE_TIMES_PER_STEP = 10_000;
/** A skipped-run notice lists this many times. */
export const SKIPPED_TIMES_LISTED = 5;

/** Due times a step skipped, reported before the mark moves past them. */
export interface SkippedRuns {
  /** The first skipped times, earliest first. */
  first: number[];
  count: number;
}

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

/** A workspace's schedules this computer runs, with each one's mark. */
export interface ScheduleRecord {
  schedules: Array<ScheduledAutomation & { throughMs: number | null }>;
}

export interface AutomationSchedulerOptions {
  clock: SchedulerClock;
  onError(context: string, error: unknown): void;
  /** A workspace's record changed, or is null once this computer runs none of its schedules. */
  onRecord?(workspaceId: string, record: ScheduleRecord | null): void;
  /** A schedule of a workspace that is not open is due: open it, and close it after its runs. */
  openInBackground?(workspaceId: string): Promise<void>;
  /**
   * A step is about to skip due times. The mark moves past them only after
   * this resolves, so a crash can repeat a report and never lose one.
   */
  onSkipped?(workspaceId: string, schedule: ScheduledAutomation, skipped: SkippedRuns): Promise<void>;
  /** The schedule changed while its skip was reported, so that skip did not happen: take the report back. */
  onSkipWithdrawn?(workspaceId: string, schedule: ScheduledAutomation, skipped: SkippedRuns): Promise<void>;
}

/** Wall time this computer did not live through: after `from`, up to and including `through`. */
export interface SkippedSpan {
  from: number;
  through: number;
}

/**
 * What one schedule's step claims: the due times to run, the mark's new
 * position, and the due times it skips, or null when nothing is due. Due
 * times at or before `coveredFrom`, or in a skipped span, are skipped. Due
 * times at or before the schedule's switch-on, or `reportFrom`, are not
 * this computer's to report: they are passed over without a word.
 */
export function planScheduleStep(
  schedule: ScheduledAutomation,
  mark: AutomationScheduleMark | undefined,
  nowMs: number,
  coveredFrom: number,
  skippedSpans: readonly SkippedSpan[] = [],
  reportFrom = Number.NEGATIVE_INFINITY,
): { run: number[]; throughMs: number; skipped?: SkippedRuns } | null {
  if (mark === undefined || mark.scheduleHash !== schedule.scheduleHash) return { run: [], throughMs: nowMs };
  if (mark.throughMs >= nowMs) return null;
  const first = nextDue(schedule.trigger, mark.throughMs);
  if (first === null || first > nowMs) return null;
  const quietUntil = Math.max(reportFrom, schedule.enabledSince ?? reportFrom);
  const due = dueTimes(schedule.trigger, Math.max(mark.throughMs, schedule.enabledSince ?? mark.throughMs), nowMs, MAX_DUE_TIMES_PER_STEP);
  const run: number[] = [];
  const skipped: SkippedRuns = { first: [], count: 0 };
  // Past a bound, the rest wait for the next step instead of being skipped.
  let throughMs = due.length === MAX_DUE_TIMES_PER_STEP ? due.at(-1)! : nowMs;
  for (const time of due) {
    if (time > coveredFrom && spanAt(skippedSpans, time) === undefined) {
      run.push(time);
      if (run.length === MAX_RUNS_PER_STEP) {
        throughMs = time;
        break;
      }
    } else if (time > quietUntil) {
      if (skipped.first.length < SKIPPED_TIMES_LISTED) skipped.first.push(time);
      skipped.count += 1;
    }
  }
  return skipped.count > 0 ? { run, throughMs, skipped } : { run, throughMs };
}

const sameSkip = (left: SkippedRuns | undefined, right: SkippedRuns | undefined) =>
  left?.count === right?.count && JSON.stringify(left?.first) === JSON.stringify(right?.first);

const spanAt = (skipped: readonly SkippedSpan[], instant: number | null) =>
  instant === null ? undefined : skipped.find((span) => span.from < instant && instant <= span.through);

interface Workspace {
  /** Null while the workspace is not open. */
  source: ScheduleSource | null;
  host: ScheduleHost | null;
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
  /** Skipped due times at or before this ran elsewhere, or may have: not reported. */
  reportFrom: number;
  /** What the last full step found, kept while the workspace is closed. */
  record: ScheduleRecord | null;
  openingInBackground: boolean;
  /** A background open that ran nothing is tried again from here. */
  retryOpenAt: number | null;
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

  /**
   * A workspace opened. Its schedules start with the start grace, or from
   * when the scheduler started watching it while it was closed.
   */
  add(workspaceId: string, source: ScheduleSource, host: ScheduleHost): void {
    const watched = this.workspaces.get(workspaceId);
    if (watched) {
      watched.source = source;
      watched.host = host;
    } else {
      this.workspaces.set(workspaceId, this.entry(source, host, null));
    }
    this.wake();
  }

  /**
   * A workspace that is not open, with the record its last open kept. Due
   * times up to 5 minutes before now still run.
   */
  watch(workspaceId: string, record: ScheduleRecord): void {
    if (this.workspaces.has(workspaceId)) return;
    this.workspaces.set(workspaceId, this.entry(null, null, record));
    this.wake();
  }

  /** How many schedules this computer runs, open or not. */
  runningSchedules(): number {
    let count = 0;
    for (const workspace of this.workspaces.values()) count += workspace.record?.schedules.length ?? 0;
    return count;
  }

  private entry(source: ScheduleSource | null, host: ScheduleHost | null, record: ScheduleRecord | null): Workspace {
    return {
      source,
      host,
      runs: null,
      marks: null,
      coveredFrom: this.options.clock.now() - START_GRACE_MS,
      skipped: [],
      unmarkedFrom: null,
      reportFrom: Number.NEGATIVE_INFINITY,
      record,
      openingInBackground: false,
      retryOpenAt: null,
    };
  }

  /**
   * This computer became the workspace's host. After another computer
   * released through `startAfterMs`, due times after it run here, less
   * what this computer did not live through. When this computer's clock
   * is behind, nothing runs until it passes the release. With no release,
   * the schedules start at now, or after `floorMs` when that is later:
   * the latest progress an earlier host reported, which a computer whose
   * clock runs behind must not run again.
   */
  startedHere(workspaceId: string, startAfterMs: number | null, floorMs: number | null): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    const now = this.options.clock.now();
    const from = startAfterMs ?? Math.max(now, floorMs ?? now);
    workspace.coveredFrom = startAfterMs === null ? from : Math.max(workspace.coveredFrom, startAfterMs);
    workspace.unmarkedFrom = startAfterMs === null ? null : workspace.coveredFrom;
    // Without a release, another computer may have run anything before now.
    workspace.reportFrom = Math.max(workspace.reportFrom, from);
    this.wake();
  }

  /**
   * This host runs the workspace's schedules again in a copy that lost its
   * marks, as a server does after it rebuilds its copy. A schedule with no
   * mark starts at `throughMs`, the progress recorded before, so nothing at
   * or before it runs again, and the due times missed since are skipped and
   * reported.
   */
  resumedHere(workspaceId: string, throughMs: number): void {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return;
    workspace.unmarkedFrom = throughMs;
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
          const through = await this.stepWorkspace(workspace, cutoff, true, workspaceId);
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
      if (workspace.runs !== false || workspace.record !== null) workspace.skipped.push({ from, through });
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
        await this.stepWorkspace(workspace, now, false, workspaceId);
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
  private async stepWorkspace(
    workspace: Workspace,
    now: number,
    handingOver: boolean,
    workspaceId: string,
  ): Promise<number | null> {
    const { source, host } = workspace;
    const schedules = source?.schedules() ?? null;
    if (source === null || host === null || schedules === null) {
      if (!handingOver) this.openIfDue(workspaceId, workspace, now);
      return null;
    }
    if (schedules.length === 0) {
      workspace.skipped = [];
      this.setRecord(workspaceId, workspace, null);
      return now;
    }
    if (!handingOver) {
      workspace.runs = await host.runsHere();
      if (!workspace.runs) {
        workspace.skipped = [];
        this.setRecord(workspaceId, workspace, null);
        return null;
      }
    }
    if (workspace.marks === null) {
      const read = await source.scheduleMarks();
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
      if (!handingOver && !host.stillRuns()) {
        workspace.runs = false;
        return null;
      }
      const schedule = source.schedules()?.find((current) => current.automationId === automationId);
      const step = schedule ? plan(schedule) : null;
      if (!schedule || step === null) return "nothing";
      const mark = await source.claimSchedule({ automationId, scheduleHash: schedule.scheduleHash, ...step });
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
      const plan = (schedule: ScheduledAutomation) =>
        planScheduleStep(schedule, marks.get(automationId), now, workspace.coveredFrom, workspace.skipped, workspace.reportFrom);
      // Reported before the mark moves past them. The claim plans again from
      // the schedule as it is then: when the schedule changed while the
      // notice was posted, the reported skip is not the one that happens,
      // so the notice is taken back and the next step reports afresh.
      const current = source.schedules()?.find((schedule) => schedule.automationId === automationId);
      const skipped = current ? plan(current)?.skipped : undefined;
      if (current && skipped) await this.options.onSkipped?.(workspaceId, current, skipped);
      let reported = skipped === undefined;
      const claimed = await claim(automationId, (schedule) => {
        const step = plan(schedule);
        if (!sameSkip(step?.skipped, skipped)) return null;
        reported = true;
        return step && { run: step.run, throughMs: step.throughMs };
      });
      if (claimed === null) return null;
      if (!reported && current && skipped) {
        // This mark did not move: the spans it still has to skip stay.
        through = Math.min(through, marks.get(automationId)?.throughMs ?? Number.NEGATIVE_INFINITY);
        await this.options.onSkipWithdrawn?.(workspaceId, current, skipped);
        this.wake();
        continue;
      }
      if (claimed !== "nothing") through = Math.min(through, claimed.throughMs);
    }
    workspace.unmarkedFrom = null;
    // Every mark passed these spans, so nothing is left to skip in them.
    workspace.skipped = workspace.skipped.filter((span) => span.through > through);
    this.setRecord(workspaceId, workspace, handingOver ? null : {
      schedules: schedules.map((schedule) => {
        const mark = marks.get(schedule.automationId);
        return { ...schedule, throughMs: mark?.scheduleHash === schedule.scheduleHash ? mark.throughMs : null };
      }),
    });
    return through;
  }

  private setRecord(workspaceId: string, workspace: Workspace, record: ScheduleRecord | null): void {
    if (JSON.stringify(record) === JSON.stringify(workspace.record)) return;
    workspace.record = record;
    this.options.onRecord?.(workspaceId, record);
  }

  // The first due time after `after` of a closed workspace's recorded
  // schedules that this computer lived through, or null.
  private recordedDue(workspace: Workspace, after: number): number | null {
    let due: number | null = null;
    for (const schedule of workspace.record?.schedules ?? []) {
      if (schedule.throughMs === null) continue;
      let from = Math.max(schedule.throughMs, workspace.coveredFrom, schedule.enabledSince ?? 0, after);
      try {
        let next = nextDue(schedule.trigger, from);
        // A due time in a span slept through or jumped over does not run.
        for (let span = spanAt(workspace.skipped, next); next !== null && span; span = spanAt(workspace.skipped, next)) {
          from = span.through;
          next = nextDue(schedule.trigger, from);
        }
        if (next !== null) due = Math.min(due ?? next, next);
      } catch (error) {
        this.options.onError(`set the timer for "${schedule.automationId}"`, error);
      }
    }
    return due;
  }

  private openIfDue(workspaceId: string, workspace: Workspace, now: number): void {
    const open = this.options.openInBackground;
    if (!open || workspace.openingInBackground) return;
    if (workspace.retryOpenAt !== null && now < workspace.retryOpenAt) return;
    const due = this.recordedDue(workspace, 0);
    if (due === null || due > now) return;
    workspace.openingInBackground = true;
    const before = workspace.record;
    void open(workspaceId)
      .catch((error: unknown) => this.options.onError(`run the schedules of closed workspace "${workspaceId}"`, error))
      .finally(() => {
        workspace.openingInBackground = false;
        // An open that moved no mark tries again within the cap, not at once.
        workspace.retryOpenAt = workspace.record === before ? this.options.clock.now() + MAX_TIMER_MS : null;
        this.wake();
      });
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
        const live = workspace.source?.schedules() ?? null;
        if (live === null || workspace.host === null) {
          // Not open: wake at the next recorded due time.
          if (!workspace.openingInBackground) {
            const due = workspace.retryOpenAt ?? this.recordedDue(workspace, now);
            if (due !== null) wakeAt = Math.min(wakeAt ?? due, due);
          }
          continue;
        }
        schedules = live;
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
