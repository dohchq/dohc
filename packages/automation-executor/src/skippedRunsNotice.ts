import { createHash } from "node:crypto";
import {
  NOTICE_POSTED_ID_MAX_CHARS,
  NOTICE_TARGET_FIELD_MAX_CHARS,
  NOTICE_TITLE_MAX_CHARS,
} from "@dohc/workspace-contracts/relay";
import type { SkippedRuns } from "./automationScheduler";
import type { ScheduledAutomation } from "./collectionAutomations";

// The notice a schedule's owner gets when a step skipped its due times, as
// when the computer slept or dohc was closed. One notice per automation and
// first skipped time, so a step that repeats after a crash posts the same
// notice again instead of a second one. Nothing catches up by default; the
// notice offers Run now.

export interface SkippedRunsNotice {
  workspaceId: string;
  noticeId: string;
  kind: "schedule-skipped";
  title: string;
  body: string;
  target: { automation: string; path?: string };
}


// Open goes to the Collection's automations.yaml, where the automation is.
function automationsFileTarget(automationId: string, collectionPath: string): SkippedRunsNotice["target"] {
  const path = `${collectionPath}/automations.yaml`;
  return [...path].length <= NOTICE_TARGET_FIELD_MAX_CHARS
    ? { automation: automationId, path }
    : { automation: automationId };
}

export function skippedRunsNotice(input: {
  workspaceId: string;
  schedule: ScheduledAutomation;
  skipped: SkippedRuns;
  formatTime?: (ms: number) => string;
}): SkippedRunsNotice {
  const { workspaceId, schedule, skipped } = input;
  // In the schedule's own zone, which each time names.
  const timeFormat = new Intl.DateTimeFormat(undefined, {
    timeZone: schedule.trigger.timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const formatTime = input.formatTime ?? ((ms: number) => timeFormat.format(ms));
  const first = skipped.first[0]!;
  let noticeId = `schedule-skipped:${workspaceId}:${schedule.automationId}:${first}`;
  if ([...noticeId].length > NOTICE_POSTED_ID_MAX_CHARS) {
    const automation = createHash("sha256").update(schedule.automationId).digest("hex").slice(0, 32);
    noticeId = `schedule-skipped:${workspaceId}:${automation}:${first}`;
  }
  const suffix = ` skipped ${skipped.count === 1 ? "once" : `${skipped.count.toLocaleString("en-US")} times`}`;
  const room = NOTICE_TITLE_MAX_CHARS - [...suffix].length;
  const name = [...schedule.name];
  const title = (name.length > room ? `${name.slice(0, room - 1).join("").trimEnd()}…` : schedule.name) + suffix;
  const more = skipped.count - skipped.first.length;
  const lines = skipped.first.map(formatTime);
  if (more > 0) lines.push(`and ${more.toLocaleString("en-US")} more`);
  return {
    workspaceId,
    noticeId,
    kind: "schedule-skipped",
    title,
    body: lines.join("\n"),
    target: automationsFileTarget(schedule.automationId, schedule.collectionPath),
  };
}
