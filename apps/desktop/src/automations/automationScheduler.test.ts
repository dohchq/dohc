import { describe, expect, it } from "vitest";
import type { AutomationScheduleTrigger } from "@dohc/workspace-contracts/automations";
import type { VersionedLiveAdapter } from "@dohc/workspace-engine-client";

type AutomationScheduleMark = Awaited<ReturnType<VersionedLiveAdapter["listAutomationScheduleMarks"]>>["marks"][number];
import {
  AutomationScheduler,
  CLOCK_JUMP_MS,
  MAX_RUNS_PER_STEP,
  MAX_TIMER_MS,
  planScheduleStep,
  START_GRACE_MS,
  type ScheduleHost,
  type ScheduleSource,
} from "./automationScheduler";
import { scheduleHash } from "./automationPlan";
import type { ScheduledAutomation } from "./collectionAutomations";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NINE = Date.UTC(2026, 8, 25, 9);

function scheduled(trigger: AutomationScheduleTrigger, automationId = "collection:Tasks#report"): ScheduledAutomation {
  return { automationId, trigger, scheduleHash: scheduleHash(trigger), enabledSince: null };
}

const hourly = scheduled({ kind: "schedule", every: "hour", at: ":00", timezone: "UTC" }, "collection:Tasks#hourly");
const daily = scheduled({ kind: "schedule", every: "day", at: "09:00", timezone: "UTC" }, "collection:Tasks#daily");

function markOf(schedule: ScheduledAutomation, throughMs: number): AutomationScheduleMark {
  return { automationId: schedule.automationId, scheduleHash: schedule.scheduleHash, throughMs };
}

// A clock whose wall time and monotonic time move together unless a test
// jumps the wall clock, and whose one timer fires when the test says.
function fakeClock(start: number) {
  let wall = start;
  let monotonic = 0;
  let timer: { wake: () => void; at: number } | null = null;
  return {
    clock: {
      now: () => wall,
      monotonic: () => monotonic,
      setTimer: (wake: () => void, delayMs: number) => (timer = { wake, at: wall + delayMs }),
      clearTimer: (handle: unknown) => { if (timer === handle) timer = null; },
    },
    advance: (ms: number) => { wall += ms; monotonic += ms; },
    jumpWall: (ms: number) => { wall += ms; },
    timerAt: () => timer?.at ?? null,
    fire: () => { const due = timer; timer = null; due?.wake(); },
  };
}

// The engine's rules for marks, and a record of every step.
function fakeSource(initialSchedules: ScheduledAutomation[], initial: AutomationScheduleMark[] = []) {
  let schedules = initialSchedules;
  const marks = new Map(initial.map((mark) => [mark.automationId, mark]));
  const steps: Array<{ automationId: string; run: number[]; throughMs: number }> = [];
  let answering = true;
  let settled: () => void = () => undefined;
  const source: ScheduleSource = {
    schedules: () => schedules,
    scheduleMarks: async () => (answering ? [...marks.values()] : null),
    claimSchedule: async ({ automationId, scheduleHash: hash, run, throughMs }) => {
      if (!answering) return null;
      steps.push({ automationId, run, throughMs });
      const mark = { automationId, scheduleHash: hash, throughMs };
      marks.set(automationId, mark);
      queueMicrotask(settled);
      return mark;
    },
  };
  return {
    source,
    steps,
    marks,
    setAnswering: (value: boolean) => { answering = value; },
    setSchedules: (next: ScheduledAutomation[]) => { schedules = next; },
    stepped: (count: number) => new Promise<void>((resolve) => {
      const check = () => { if (steps.length >= count) resolve(); else settled = check; };
      check();
    }),
  };
}

const idle = (scheduler: AutomationScheduler) => scheduler.idle();
const here: ScheduleHost = { runsHere: async () => true, stillRuns: () => true };
const elsewhere: ScheduleHost = { runsHere: async () => false, stillRuns: () => false };

describe("planScheduleStep", () => {
  it("starts a new or changed schedule's mark at now, running nothing", () => {
    expect(planScheduleStep(daily, undefined, NINE, 0)).toEqual({ run: [], throughMs: NINE });
    expect(planScheduleStep(daily, { ...markOf(daily, 0), scheduleHash: "other" }, NINE, 0))
      .toEqual({ run: [], throughMs: NINE });
  });

  it("runs the due times it reached and skips those before coveredFrom", () => {
    const mark = markOf(hourly, NINE - 5 * HOUR);
    expect(planScheduleStep(hourly, mark, NINE, NINE - 90 * MINUTE)).toEqual({
      run: [NINE - HOUR, NINE],
      throughMs: NINE,
    });
    expect(planScheduleStep(hourly, markOf(hourly, NINE), NINE + 30 * MINUTE, 0), "nothing due").toBeNull();
    expect(planScheduleStep(hourly, markOf(hourly, NINE + HOUR), NINE, 0), "a mark ahead of the clock").toBeNull();
  });

  it("leaves due times past the engine's bound for the next step", () => {
    const every = scheduled({ kind: "schedule", every: "hour", at: ":00", timezone: "UTC" });
    const step = planScheduleStep(every, markOf(every, NINE - 200 * HOUR), NINE, 0)!;
    expect(step.run).toHaveLength(MAX_RUNS_PER_STEP);
    expect(step.throughMs).toBe(step.run[MAX_RUNS_PER_STEP - 1]);
  });
});

describe("AutomationScheduler", () => {
  it("starts new schedules at now and sets one timer for the earliest due time", async () => {
    const time = fakeClock(NINE - 10 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([daily, hourly]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: daily.automationId, run: [], throughMs: NINE - 10 * MINUTE },
      { automationId: hourly.automationId, run: [], throughMs: NINE - 10 * MINUTE },
    ]);
    expect(time.timerAt()).toBe(NINE);

    // The timer fires late; the due time still runs.
    time.advance(13 * MINUTE);
    time.fire();
    await idle(scheduler);
    expect(work.steps.slice(2)).toEqual([
      { automationId: daily.automationId, run: [NINE], throughMs: NINE + 3 * MINUTE },
      { automationId: hourly.automationId, run: [NINE], throughMs: NINE + 3 * MINUTE },
    ]);
    expect(time.timerAt(), "never more than 15 minutes ahead").toBe(NINE + 3 * MINUTE + MAX_TIMER_MS);
    scheduler.dispose();
  });

  it("skips what was due before the start grace, and runs what is within it", async () => {
    const time = fakeClock(NINE + 3 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 3 * HOUR)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(NINE > NINE + 3 * MINUTE - START_GRACE_MS).toBe(true);
    expect(work.steps).toEqual([{ automationId: hourly.automationId, run: [NINE], throughMs: NINE + 3 * MINUTE }]);
    scheduler.dispose();
  });

  it("skips what was due while the computer slept, and runs what was due before it slept", async () => {
    const time = fakeClock(NINE - 30 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 30 * MINUTE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(work.steps).toEqual([]);

    time.advance(31 * MINUTE);
    scheduler.suspended();
    expect(time.timerAt(), "no timer while asleep").toBeNull();
    time.advance(3 * HOUR);
    scheduler.resumed();
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: hourly.automationId, run: [NINE], throughMs: NINE + 1 * MINUTE + 3 * HOUR },
    ]);
    scheduler.dispose();
  });

  it("keeps skipping the sleep when the step after it fails", async () => {
    const time = fakeClock(NINE - 30 * MINUTE);
    const errors: string[] = [];
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (context) => { errors.push(context); } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 30 * MINUTE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);

    time.advance(31 * MINUTE);
    scheduler.suspended();
    time.advance(3 * HOUR);
    const claim = work.source.claimSchedule;
    work.source.claimSchedule = async () => { throw new Error("The engine refused the step."); };
    scheduler.resumed();
    await idle(scheduler);
    expect(errors).toEqual(['step the schedules in workspace "ws"']);

    work.source.claimSchedule = claim;
    time.advance(MINUTE);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: hourly.automationId, run: [NINE], throughMs: NINE + 2 * MINUTE + 3 * HOUR },
    ]);
    scheduler.dispose();
  });

  it("skips what the wall clock jumped over, and not across a small drift", async () => {
    const time = fakeClock(NINE - 30 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 30 * MINUTE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);

    time.advance(10 * MINUTE);
    time.jumpWall(CLOCK_JUMP_MS);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps, "a small drift skips nothing and nothing is due").toEqual([]);

    // Nine runs when its timer fires. The clock is then set two hours
    // ahead: ten and eleven, which the jump passed over, are skipped.
    time.advance(20 * MINUTE - CLOCK_JUMP_MS);
    time.fire();
    await idle(scheduler);
    time.advance(15 * MINUTE);
    time.jumpWall(2 * HOUR);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: hourly.automationId, run: [NINE], throughMs: NINE },
      { automationId: hourly.automationId, run: [], throughMs: time.clock.now() },
    ]);
    scheduler.dispose();
  });

  it("skips everything after the last check when the clock jumps inside the timer's wait", async () => {
    const time = fakeClock(NINE - 15 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 15 * MINUTE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(time.timerAt()).toBe(NINE);

    // Five minutes in, the clock is set two hours ahead; the timer fires
    // fifteen minutes after it was set. The clock never showed nine.
    time.advance(5 * MINUTE);
    time.jumpWall(2 * HOUR);
    time.advance(10 * MINUTE);
    time.fire();
    await idle(scheduler);
    expect(work.steps).toEqual([{ automationId: hourly.automationId, run: [], throughMs: NINE + 2 * HOUR }]);
    scheduler.dispose();
  });

  it("skips what a clock jump crossed while a step waited on the engine", async () => {
    const time = fakeClock(NINE - 20 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly, daily], [markOf(hourly, NINE - 20 * MINUTE), markOf(daily, NINE - 20 * MINUTE)]);
    const marks = work.source.scheduleMarks;
    // The clock is set two hours ahead while the step reads the marks.
    work.source.scheduleMarks = async () => {
      time.jumpWall(2 * HOUR);
      return await marks();
    };
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(work.steps).toEqual([]);

    time.advance(MINUTE);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: hourly.automationId, run: [], throughMs: NINE + 2 * HOUR - 19 * MINUTE },
      { automationId: daily.automationId, run: [], throughMs: NINE + 2 * HOUR - 19 * MINUTE },
    ]);
    scheduler.dispose();
  });

  it("starts a schedule switched back on at the switch-on, without the time it was off", async () => {
    const time = fakeClock(NINE - 10 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly, daily], [markOf(hourly, NINE - 10 * MINUTE), markOf(daily, NINE - 10 * MINUTE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);

    // Off at 8:50 and on at 10:10, with no step between.
    time.advance(80 * MINUTE);
    work.setSchedules([daily, { ...hourly, enabledSince: NINE + 70 * MINUTE }]);
    time.advance(5 * MINUTE);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps).toEqual([
      { automationId: daily.automationId, run: [NINE], throughMs: NINE + 75 * MINUTE },
      { automationId: hourly.automationId, run: [], throughMs: NINE + 75 * MINUTE },
    ]);
    scheduler.dispose();
  });

  it("plans each claim from the schedule as it is right then", async () => {
    const time = fakeClock(NINE + 3 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 10 * MINUTE)]);
    // Switched off and on again at 9:03 while the step asks who runs it.
    const host: ScheduleHost = {
      runsHere: async () => {
        work.setSchedules([{ ...hourly, enabledSince: NINE + 3 * MINUTE }]);
        return true;
      },
      stillRuns: () => true,
    };
    scheduler.add("ws", work.source, host);
    await idle(scheduler);
    expect(work.steps).toEqual([{ automationId: hourly.automationId, run: [], throughMs: NINE + 3 * MINUTE }]);
    scheduler.dispose();
  });

  it("keeps a sleep while its first answer on who runs the workspace is out", async () => {
    const time = fakeClock(NINE - MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 10 * MINUTE)]);
    let answer: (runs: boolean) => void = () => undefined;
    let first = true;
    const host: ScheduleHost = {
      runsHere: () => {
        if (!first) return Promise.resolve(true);
        first = false;
        return new Promise<boolean>((resolve) => { answer = resolve; });
      },
      stillRuns: () => true,
    };
    scheduler.add("ws", work.source, host);
    // Asleep from 8:59 to 9:03 while the first answer is out.
    scheduler.suspended();
    time.advance(4 * MINUTE);
    scheduler.resumed();
    answer(true);
    await idle(scheduler);
    expect(work.steps).toEqual([{ automationId: hourly.automationId, run: [], throughMs: NINE + 3 * MINUTE }]);
    scheduler.dispose();
  });

  it("claims nothing once the workspace starts to sync during a step", async () => {
    const time = fakeClock(NINE + 3 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly], [markOf(hourly, NINE - 30 * MINUTE)]);
    let local = true;
    const marks = work.source.scheduleMarks;
    work.source.scheduleMarks = async () => {
      // Sync is turned on while the step reads the marks.
      local = false;
      return await marks();
    };
    scheduler.add("ws", work.source, { runsHere: async () => local, stillRuns: () => local });
    await idle(scheduler);
    expect(work.steps).toEqual([]);
    expect(time.timerAt(), "no timer for a workspace it does not run").toBeNull();
    scheduler.dispose();
  });

  it("keeps a timer and reports a schedule it cannot follow", async () => {
    const time = fakeClock(NINE);
    const errors: string[] = [];
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (context) => { errors.push(context); } });
    // A mark past the year 9999, which the next-run module refuses.
    const work = fakeSource([daily, hourly], [markOf(daily, Date.UTC(10_000, 0, 2)), markOf(hourly, NINE)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(errors).toEqual([`set the timer for "${daily.automationId}"`]);
    expect(time.timerAt(), "the other schedule still wakes the timer").toBe(NINE + MAX_TIMER_MS);
    scheduler.dispose();
  });

  it("reads the marks again after the engine refuses a step", async () => {
    const time = fakeClock(NINE - 10 * MINUTE);
    const errors: string[] = [];
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (context) => { errors.push(context); } });
    const work = fakeSource([daily], [markOf(daily, NINE - HOUR)]);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);

    // The engine's store was rebuilt: it has no mark and refuses a due time.
    work.marks.clear();
    const claim = work.source.claimSchedule;
    work.source.claimSchedule = async (input) => {
      if (input.run.length > 0 && !work.marks.has(input.automationId)) throw new Error("A new or changed schedule sets its mark first.");
      return await claim(input);
    };
    time.advance(12 * MINUTE);
    scheduler.wake();
    await idle(scheduler);
    expect(errors).toEqual(['step the schedules in workspace "ws"']);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps.at(-1)).toEqual({ automationId: daily.automationId, run: [], throughMs: NINE + 2 * MINUTE });
    scheduler.dispose();
  });

  it("runs nothing for a workspace this computer does not run, and no timer", async () => {
    const time = fakeClock(NINE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([hourly]);
    scheduler.add("ws", work.source, elsewhere);
    await idle(scheduler);
    expect(work.steps).toEqual([]);
    expect(time.timerAt()).toBeNull();
    scheduler.dispose();
  });

  it("waits for the engine and reads the marks again when it answers", async () => {
    const time = fakeClock(NINE - 10 * MINUTE);
    const scheduler = new AutomationScheduler({ clock: time.clock, onError: (_, error) => { throw error; } });
    const work = fakeSource([daily], [markOf(daily, NINE - HOUR)]);
    work.setAnswering(false);
    scheduler.add("ws", work.source, here);
    await idle(scheduler);
    expect(work.steps).toEqual([]);
    expect(time.timerAt(), "tries again within 15 minutes").toBe(NINE - 10 * MINUTE + MAX_TIMER_MS);

    time.advance(12 * MINUTE);
    work.setAnswering(true);
    scheduler.wake();
    await idle(scheduler);
    expect(work.steps).toEqual([{ automationId: daily.automationId, run: [NINE], throughMs: NINE + 2 * MINUTE }]);
    scheduler.remove("ws");
    await idle(scheduler);
    expect(time.timerAt(), "no schedules, no timer").toBeNull();
    scheduler.dispose();
  });
});
