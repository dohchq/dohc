import { AGENT_RUN_SCAN_MAX_PAGES } from "@dohc/workspace-contracts/agent-run-undo";
import { leftNoteGroups } from "@dohc/workspace-contracts/note-format";
import type { CliGrepContextMessage, CliGrepMatch, CliResultByVerb } from "./protocol";
import { renderAuthorDisplayName } from "./chatIdentity";
import {
  formatStreamPosition,
  messageMetadata,
  renderDecisionOptions,
  renderThreadMarkdown,
} from "./threadMarkdown";
import { DohcCliError } from "./errors";
import { MEMBERS_REFUSED, type InvitationEmailAnswer } from "./members";
import { formatStoredBytes } from "./account";

type GroupsResult = CliResultByVerb["groups"];
type ThreadsResult = CliResultByVerb["threads"];
type InboxResult = CliResultByVerb["inbox"];
type NoticesResult = CliResultByVerb["notices"];
export type ShowResult = CliResultByVerb["show"];
type PostResult = CliResultByVerb["post"];
type ReplyResult = CliResultByVerb["reply"];
type ReactResult = CliResultByVerb["react"];
type ExportResult = CliResultByVerb["export"];

function lineSafe(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function conflictLines(
  page: Pick<
    Extract<CliResultByVerb["versionConflicts"], { ok: true }>,
    "conflicts" | "nextAfterConflictId"
  >,
): string[] {
  return [
    ...page.conflicts.flatMap((conflict) => [
      `${conflict.conflictId} · ${conflict.origin} · ${lineSafe(conflict.path)}${conflict.contentKind === "binary" ? " · binary" : ""}`,
      ...(conflict.waiting
        ? [
            "  A newer version from another computer is waiting. It comes in after you resolve this conflict.",
          ]
        : []),
    ]),
    ...(page.nextAfterConflictId
      ? [`More conflicts; use --after ${page.nextAfterConflictId}`]
      : []),
  ];
}

function renderAccountDeletionPreview(preview: CliResultByVerb["accountDeletePreview"]): string {
  const local = preview.workspaces.map((workspace) => lineSafe(workspace.name));
  return [
    `Deleting ${preview.email} on ${preview.server} removes it from the server, with:`,
    `  ${counted(local.length, "workspace", "workspaces")} on this computer${local.length ? `: ${local.join(", ")}` : ""}`,
    `  ${counted(preview.workspacesElsewhere, "workspace", "workspaces")} not on this computer`,
    `  ${formatStoredBytes(preview.storedBytes)} of stored files, data, apps, chats, and history`,
    `  ${counted(preview.ownedShareCount, "share", "shares")} you own. People you shared with lose access and keep their copies.`,
    "  your access to shares others gave you",
    "Copies on this computer stay. This cannot be undone.",
    "If you create an account again later, this server will not accept your old copies of these workspaces.",
    "The server's backups keep the data until they expire.",
    "",
    "To delete, run this within five minutes. dohc asks for the account password:",
    `  dohc account delete --server ${preview.server} --preview-token ${preview.previewToken}`,
  ].join("\n");
}

function dateTime(atMs: number): string {
  return new Date(atMs).toISOString();
}

function dateOnly(atMs: number): string {
  return dateTime(atMs).slice(0, 10);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function decisionCount(count: number): string {
  return count === 0 ? "none" : String(count);
}

export function renderShowMarkdown(result: ShowResult): string {
  return "stream" in result ? renderStream(result.stream) : renderThreadMarkdown(result);
}

type StreamResult = Extract<ShowResult, { stream: unknown }>["stream"];

// A group's stream, oldest first: each post with what its thread holds, and
// each conversation message. The person's read position is marked.
function renderStream(stream: StreamResult): string {
  const lines = [`# #${stream.group.slug}`];
  if (stream.nextBefore) lines.push(`older: --before ${formatStreamPosition(stream.nextBefore)}`);
  const read = stream.readPosition && formatStreamPosition(stream.readPosition);
  for (const item of stream.items) {
    const metadata = messageMetadata(item.message, item.post ? item.threadId : item.message.id);
    if (item.message.decisionState) metadata.push(`needs-decision(${item.message.decisionState})`);
    const { post } = item;
    if (post) {
      metadata.push(countLabel(post.replyCount, "reply", "replies"));
      if (post.repliers.length > 0) {
        metadata.push(
          `from ${post.repliers.map((replier) => renderAuthorDisplayName(replier.author)).join(", ")}`,
        );
      }
      if (post.lastReplyAtMs !== undefined)
        metadata.push(`last reply ${dateTime(post.lastReplyAtMs)}`);
      if (post.openDecisionCount > 0) metadata.push(`open decisions: ${post.openDecisionCount}`);
    }
    lines.push("", metadata.join(" · "), item.message.body);
    lines.push(...renderDecisionOptions(item.message));
    if (post?.latestAgentReply) {
      const reply = post.latestAgentReply;
      lines.push(
        `> **${renderAuthorDisplayName(reply.author)}** · ${dateTime(reply.createdAtMs)} · ${reply.id}: ${lineSafe(reply.bodyExcerpt)}`,
      );
    }
    if (read === formatStreamPosition(item.position)) lines.push("", "--- read up to here ---");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderGroups(result: GroupsResult): string {
  return result.groups
    .map((group) => {
      const name = group.kind === "agent" ? lineSafe(group.slug) : lineSafe(group.name);
      return `${name} · #${group.slug} · ${group.kind} · ${group.id}`;
    })
    .join("\n");
}

export function renderThreads(result: ThreadsResult): string {
  const lines = [`#${result.group.slug} · ${result.group.id}`];
  for (const thread of result.threads) {
    lines.push(
      `${thread.unread ? "[unread] · " : ""}${thread.id} · ${lineSafe(thread.title)} · ${countLabel(thread.commentCount, "comment")} · open decisions: ${decisionCount(thread.openDecisionCount)}`,
    );
  }
  return lines.join("\n");
}

// One row per notice, then its text and where it opens: a path, the message
// or thread to show, or an automation. A row with nowhere to go says why.
export function renderNotices(result: NoticesResult): string {
  return result.notices
    .map((notice) => {
      const sender = notice.sender?.label ? ` · ${lineSafe(notice.sender.label)}` : "";
      const lines = [
        `${notice.read ? "[read]" : "[unread]"} · ${dateOnly(notice.createdAtMs)}${sender} · ${lineSafe(notice.title)}`,
      ];
      if (notice.body) lines.push(`  ${lineSafe(notice.body)}`);
      if (notice.opens) lines.push(`  opens: ${noticeOpensLabel(notice.opens)}`);
      else if (notice.note) lines.push(`  ${lineSafe(notice.note)}`);
      return lines.join("\n");
    })
    .join("\n");
}

function noticeOpensLabel(opens: NonNullable<NoticesResult["notices"][number]["opens"]>): string {
  switch (opens.to) {
    case "file":
    case "folder":
      return lineSafe(opens.path);
    case "chat":
      return opens.message ?? opens.thread;
    case "automation":
    case "automation-controls":
      return `automation ${lineSafe(opens.automation)}`;
  }
}

export function renderInbox(result: InboxResult): string {
  const lines: string[] = [];
  for (const thread of result.threads) {
    lines.push(
      `[unread] · ${thread.id} · #${thread.group.slug} · ${lineSafe(thread.title)} · ${countLabel(thread.commentCount, "comment")} · open decisions: ${decisionCount(thread.openDecisionCount)}`,
    );
  }
  for (const mention of result.mentions) {
    lines.push(
      `@mention · #${mention.group.slug} · ${mention.threadId} · ${mention.messageId} · ${lineSafe(renderAuthorDisplayName(mention.author))} · ${dateOnly(mention.createdAtMs)}  ${lineSafe(mention.text)}`,
    );
  }
  return lines.join("\n");
}

function renderPost(result: PostResult): string {
  const posted = `posted ${result.threadId} ${result.messageId} in #${result.group.slug}`;
  return result.warning ? `${posted}\nwarning: ${result.warning}` : posted;
}

function renderReply(result: ReplyResult): string {
  const details = [`replied ${result.threadId} ${result.messageId}`];
  if (result.parentMessageId) details.push(`to ${result.parentMessageId}`);
  if (result.resolvedMessageId) details.push(`resolved ${result.resolvedMessageId}`);
  const replied = details.join(" · ");
  return result.warning ? `${replied}\nwarning: ${result.warning}` : replied;
}

function renderReact(result: ReactResult): string {
  return `${result.state} ${result.emoji} on ${result.messageId} in ${result.threadId}`;
}

function renderGrepLine(
  match: Pick<CliGrepMatch, "group" | "threadId">,
  message:
    | CliGrepContextMessage
    | Pick<CliGrepMatch, "messageId" | "author" | "createdAtMs" | "text">,
  context: boolean,
): string {
  const contextMarker = context ? "- " : "";
  return `#${match.group.slug} ${match.threadId} ${message.messageId} ${lineSafe(renderAuthorDisplayName(message.author))} ${dateOnly(message.createdAtMs)}  ${contextMarker}${lineSafe(message.text)}`;
}

export function renderGrep(
  result: CliResultByVerb["grep"],
  options: { filesWithMatches: boolean; context: number },
): string {
  if ("threadIds" in result) return result.threadIds.join("\n");
  if (options.filesWithMatches) {
    return [...new Set(result.matches.map((match) => match.threadId))].join("\n");
  }
  const groups = result.matches.map((match) => {
    if (options.context === 0) return renderGrepLine(match, match, false);
    return [
      ...match.contextBefore.map((message) => renderGrepLine(match, message, true)),
      renderGrepLine(match, match, false),
      ...match.contextAfter.map((message) => renderGrepLine(match, message, true)),
    ].join("\n");
  });
  return groups.join(options.context > 0 ? "\n--\n" : "\n");
}

function renderExport(result: ExportResult): string {
  return result.files.map((file) => `${file.threadId}  ${file.path}`).join("\n");
}

function renderMoments(result: CliResultByVerb["moments"]): string {
  // A refusal exits with its reason before anything renders.
  if (!("changes" in result)) return "";
  const lines = result.changes.map((change) => {
    const agents = (change.authors ?? [])
      .map((author) => (author.kind === "agent" ? ` · agent ${author.agentId}` : ""))
      .join("");
    return `${change.id} · ${dateTime(change.recordedAtMs)} · ${change.operation} · ${change.path}${agents}${change.operationId ? ` · operation ${change.operationId}` : ""}`;
  });
  if (result.hasMore)
    lines.push(`${result.totalAvailable - result.count} more; raise --limit to list them`);
  return lines.join("\n");
}

function renderMoment(result: CliResultByVerb["moment"], side: "before" | "after"): string {
  if (!result.ok) throw new DohcCliError(result.reason);
  const { change } = result;
  const snapshot = side === "before" ? change.before : change.after;
  if (side === "before" && snapshot === null) {
    throw new DohcCliError(`${change.id} created ${change.path}; it has no text before it`);
  }
  if (side === "after" && change.operation === "delete") {
    throw new DohcCliError(`${change.id} deleted ${change.path}; use --before for its last text`);
  }
  if (!snapshot || snapshot.contentKind === "binary") {
    throw new DohcCliError(
      `${change.path} is binary at ${change.id}; history show prints text only`,
    );
  }
  return snapshot.text;
}

type AutomationRunsResult = Extract<CliResultByVerb["automationRuns"], { ok: true }>;
type AutomationRunResult = Extract<CliResultByVerb["automationRun"], { ok: true }>;
type AutomationRunLine = AutomationRunsResult["runs"][number];
type AutomationRunChange = Extract<AutomationRunResult["run"], { server: true }>["changes"][number];

const TRIGGER_KINDS = {
  added: "record added",
  changed: "record changed",
  removed: "record removed",
  message: "Group message",
  button: "button pressed",
  schedule: "schedule",
} as const;

function triggerText(trigger: AutomationRunLine["trigger"]): string {
  return [
    trigger.kind === null ? "unknown change" : TRIGGER_KINDS[trigger.kind],
    ...(trigger.recordId === null ? [] : [`record ${trigger.recordId}`]),
    ...(trigger.by === null ? [] : [`by ${trigger.by}`]),
    ...(trigger.sharedAuthor === null
      ? []
      : trigger.sharedAuthor.kind === "link"
        ? [`through Edit link ${trigger.sharedAuthor.grantId}`]
        : [`by shared user ${trigger.sharedAuthor.userId}`]),
    ...(trigger.depth > 0 ? [`depth ${trigger.depth}`] : []),
  ].join(" · ");
}

function runStateText(run: Omit<AutomationRunLine, "changes">): string {
  return [
    run.chainStopped ? "chain stopped" : run.neverStarted ? "never started" : run.state,
    ...(run.undone ? ["undone"] : []),
    ...(run.definitionChanged ? ["automation changed since"] : []),
  ].join(", ");
}

function renderAutomationRuns(result: AutomationRunsResult): string {
  const lines = result.runs.map((run) =>
    [
      run.run,
      dateTime(run.createdAtMs),
      runStateText(run),
      triggerText(run.trigger),
      countLabel(run.changes, "change"),
      ...(run.error === null ? [] : [lineSafe(run.error)]),
    ].join(" · "),
  );
  return [
    ...lines,
    ...(result.next === null ? [] : [`Older runs: --page ${lineSafe(result.next)}`]),
  ].join("\n");
}

function json(value: unknown): string {
  return lineSafe(JSON.stringify(value) ?? "null");
}

function changeText(change: AutomationRunChange): string {
  switch (change.kind) {
    case "field":
      return `set ${change.field} on ${change.path}: ${json(change.before)} -> ${json(change.after)}`;
    case "created":
      return `added ${change.path}`;
    case "kept":
      return `kept ${change.field} on ${change.path} as someone changed it: ${json(change.current)}, not ${json(change.planned)}`;
    case "skipped":
      return `skipped ${change.path}: ${lineSafe(change.reason)}`;
    case "dataset-edit":
      return `set ${change.fields.map((field) => `${field.field} ${json(field.before)} -> ${json(field.after)}`).join(", ")} on record ${change.recordId} in table ${change.tableId}`;
    case "dataset-created":
      return `added record ${change.recordId} in table ${change.tableId}`;
    case "dataset-action":
      return `ran ${lineSafe(change.name)} in table ${change.tableId}`;
    case "dataset-kept":
      return `kept ${change.field} on record ${change.recordId} as someone changed it: ${json(change.current)}, not ${json(change.planned)}`;
    case "dataset-skipped":
      return `skipped record ${change.recordId}: ${lineSafe(change.reason)}`;
    case "message":
      return `posted to ${lineSafe(change.name)} · ${change.messageId}`;
    case "notice":
      return `sent a notice to ${lineSafe(change.name)} · ${change.noticeId}`;
    case "http-sent":
      return `${change.fetched ? "fetched data from" : change.method === "GET" ? "sent a GET request to" : "sent webhook to"} ${lineSafe(change.target)} (HTTP ${change.status}) · ${change.deliveryId}`;
  }
}

function renderAutomationRun({ run }: AutomationRunResult): string {
  const head = [
    `${run.run} · ${dateTime(run.createdAtMs)} · ${runStateText(run)}`,
    `trigger: ${triggerText(run.trigger)}`,
    ...(run.error === null ? [] : [`error: ${lineSafe(run.error)}`]),
  ];
  if ("server" in run) return [...head, ...run.changes.map(changeText)].join("\n");
  return [
    ...head,
    ...(run.failedStep === null ? [] : [`step ${run.failedStep} failed`]),
    ...(run.startsOver
      ? ["Try again starts over from step 1 and needs --start-over."]
      : run.failedStep === null
        ? []
        : [`Try again resumes at step ${run.failedStep}.`]),
    ...run.steps.flatMap((step) => [
      `step ${step.step}:`,
      ...step.changes.map((change) => `  ${changeText(change)}`),
    ]),
  ].join("\n");
}

function renderAutomationPress(
  result: Extract<CliResultByVerb["automationPress"], { ok: true }>,
): string {
  if ("relayed" in result) return "sent to the owner's computer, which runs it";
  const ran =
    result.outcome === null ? `started run ${result.run}` : `run ${result.run} ${result.outcome}`;
  return [
    result.error === null ? ran : `${ran}: ${lineSafe(result.error)}`,
    ...(result.waiting === null ? [] : [result.waiting]),
  ].join("\n");
}

// An agent reports its own name. Print it quoted, as reported, with each
// character that could move, recolor, or reorder the terminal as its code point.
function reportedText(name: string): string {
  return `"${name.replace(/[\\"\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, (char) =>
    char === "\\" || char === '"' ? `\\${char}` : `\\u{${char.codePointAt(0)!.toString(16)}}`,
  )}"`;
}

function renderLinkAgents(page: CliResultByVerb["shareAgents"]): string {
  if (page.agents.length === 0 && page.nextCursor === null)
    return "No agent is connected through this link.";
  return [
    ...page.agents.map((agent) =>
      [
        agent.connectionId,
        agent.reportedName === null
          ? "no reported name"
          : `reported name ${reportedText(agent.reportedName)}`,
        `signed in ${dateTime(agent.connectedAtMs)}`,
        agent.lastActionAtMs === null
          ? "no action yet"
          : `last action ${dateTime(agent.lastActionAtMs)}`,
      ].join(" · "),
    ),
    ...(page.nextCursor === null ? [] : [`More agents; use --cursor ${page.nextCursor}`]),
  ].join("\n");
}

const LEVEL_WORDS = { view: "view", comment: "comment", edit: "edit" } as const;
const ROLE_WORDS = { owner: "Owner", admin: "Admin", member: "Member" } as const;
const GROUP_LEVEL_LINES = {
  comment: (name: string) => `Members can post in ${name}.`,
  view: (name: string) => `Members can read ${name} but not post.`,
  none: (name: string) => `Members can't see ${name}.`,
} as const;

// The Members page as lines: who is in the workspace, then invites and
// removed accounts, each by name and role, with the id the other verbs take last.
// The owner's id names no one a verb can act on, so its row ends at the email.
function renderMembers(result: CliResultByVerb["members"]): string {
  if (result.status === "refused") throw new DohcCliError(MEMBERS_REFUSED);
  // Agents can't leave, so only a delete finishes with done.
  if (result.status === "done") return "Message deleted.";
  if (result.status === "group") {
    const name = lineSafe(result.name);
    if (result.level === null)
      return `${name} has no access of its own: members can ${LEVEL_WORDS[result.memberLevel]}, as everywhere.`;
    return GROUP_LEVEL_LINES[result.level](name);
  }
  const { view, invitation } = result;
  const row = (person: (typeof view.people)[number]) =>
    [
      person.name === null ? null : lineSafe(person.name),
      person.name === null && person.email !== null ? lineSafe(person.email) : null,
      person.state === "invited"
        ? "Invited"
        : person.state === "removed"
          ? "Removed"
          : ROLE_WORDS[person.role],
      person.name === null || person.email === null ? null : lineSafe(person.email),
      person.role === "owner" && person.state === "active" ? null : person.memberId,
    ]
      .filter((part) => part !== null)
      .join(" · ");
  const active = view.people.filter((person) => person.state === "active");
  const invited = view.people.filter((person) => person.state === "invited");
  const removed = view.people.filter((person) => person.state === "removed");
  return [
    `${lineSafe(view.workspaceName) || "This workspace"}: members can ${LEVEL_WORDS[view.memberLevel]}.`,
    ...(view.inviteLink === null
      ? []
      : [
          view.inviteLink.enabled && view.inviteLink.url
            ? `Invite link: ${view.inviteLink.url}`
            : "Invite link: off",
        ]),
    "",
    ...active.map(row),
    ...(invited.length
      ? ["", "Invites (each joins when they sign in with that address)", ...invited.map(row)]
      : []),
    ...(removed.length ? ["", "Removed (dohc members let-back-in <id>)", ...removed.map(row)] : []),
    ...(view.folderRules ?? []).flatMap(({ folders, members, people }) => [
      "",
      ...folders.map(({ path, state }) => `${lineSafe(path) || "/"} · ${state.replace("-", " ")}`),
      `  Members: ${members ?? "none"}`,
      ...people.map(({ email, level }) => `  ${lineSafe(email)}: ${level}`),
    ]),
    ...(invitation ? ["", invitationLine(invitation)] : []),
  ].join("\n");
}

function invitationLine(answer: InvitationEmailAnswer): string {
  switch (answer.invitationEmail) {
    case "sent":
      return "Emailed the invitation.";
    case "unavailable":
      return "No email sent: this server does not send email. Tell them to sign in to dohc with that address.";
    case "recent":
      return "No email sent: dohc already tried to email this invitation in the last minute. Wait a minute before trying again.";
    case "limit": {
      const { sent, limit, windowHours } = answer.invitationEmailLimit;
      return `No email sent: ${sent} of ${limit} invitation emails used in the last ${windowHours} ${windowHours === 1 ? "hour" : "hours"}. Tell them to sign in to dohc with that address.`;
    }
    case "failed":
      return "The invite stands, but dohc could not send the email. Run the same invite again to retry.";
  }
}

const LIVE_REASON_WORDS = {
  "document-unavailable": "file moved or removed",
  "workspace-changed": "workspace changed",
  "session-host-refused": "stopped by the server",
  "session-host-diverged": "server copy doesn't match",
  "live-document-without-lineage": "not started",
  "live-document-too-large": "too large",
  "live-edit-unadmitted": "server copy is missing an edit",
  "conflict-parent-withheld": "can't resume",
  "live-history-over-budget": "history too long",
  "live-start-failing": "can't start",
  "note-format-off": "note format off on the server",
} as const;
const LIVE_STATUS_WORDS = {
  ready: "live",
  preparing: "starting",
  paused: "paused",
  unavailable: "unavailable",
  retired: "stopped",
} as const;

function renderLiveDocuments(
  page: Extract<CliResultByVerb["liveDocuments"], { ok: true }>,
): string {
  if (page.documents.length === 0 && page.nextCursor === null)
    return "No document has live editing.";
  return [
    ...page.documents.map((row) =>
      [
        lineSafe(row.path),
        row.movedTo
          ? `moved to ${lineSafe(row.movedTo)}`
          : row.reason === "session-host-refused" && row.record?.reason === "start-failed"
            ? "can't start"
            : row.reason
              ? LIVE_REASON_WORDS[row.reason]
              : row.status === "retired" && row.stopped === false
                ? "not live"
                : LIVE_STATUS_WORDS[row.status],
        ...(row.failure ? [`server's reason ${row.failure.word} since ${row.failure.since}`] : []),
        ...(row.canResume && !row.saveOnly ? ["can resume"] : []),
        ...(row.deferredStop
          ? [
              `Stop waits for ${row.deferredStop.unsentEdits} unsent ${row.deferredStop.unsentEdits === 1 ? "edit" : "edits"}`,
            ]
          : []),
        ...(row.quarantine ? [`kept edits ${row.quarantine}`] : []),
      ].join(" · "),
    ),
    ...(page.nextCursor === null
      ? []
      : [`More documents; use --cursor ${lineSafe(page.nextCursor)}`]),
  ].join("\n");
}

export function renderCliResult<Verb extends keyof CliResultByVerb>(
  verb: Verb,
  result: CliResultByVerb[Verb],
  options: {
    grepFilesWithMatches?: boolean;
    grepContext?: number;
    momentSide?: "before" | "after";
  } = {},
): string {
  switch (verb) {
    case "accountDeletePreview":
      return renderAccountDeletionPreview(result as CliResultByVerb["accountDeletePreview"]);
    case "accountDelete": {
      const deleted = result as CliResultByVerb["accountDelete"];
      if (!deleted.ok) throw new DohcCliError(deleted.reason);
      const outcome = deleted.finished
        ? `Deleted ${deleted.email} on ${deleted.server}.`
        : `${deleted.email} on ${deleted.server} is blocked. The server will finish removing its data.`;
      if (deleted.disconnectError === null) {
        return `${outcome} The dohc app disconnected from this server. Workspaces on this computer stay.`;
      }
      return [
        `${outcome} Workspaces on this computer stay.`,
        `The dohc app could not disconnect from this server: ${lineSafe(deleted.disconnectError)}`,
        `Quit and reopen the dohc app. If Settings > Sync and sharing still shows ${deleted.email}, choose Disconnect.`,
      ].join("\n");
    }
    case "shareCopy":
    case "accessRefresh":
    case "accessObject":
    case "accessSharing":
      return JSON.stringify(result, null, 2);
    case "shareAgents":
      return renderLinkAgents(result as CliResultByVerb["shareAgents"]);
    case "members":
      return renderMembers(result as CliResultByVerb["members"]);
    case "shareDisconnect":
      return `Disconnected ${(result as CliResultByVerb["shareDisconnect"]).connectionId}`;
    case "automationList":
    case "automationSwitch":
    case "automationHost":
    case "webhookList":
      return JSON.stringify(result, null, 2);
    case "automationUseServer": {
      const moved = result as Extract<CliResultByVerb["automationUseServer"], { ok: true }>;
      if (moved.outcome === "handover-pending")
        return `The server runs automations once ${lineSafe(moved.handoverFrom ?? "the other computer")} hands them over. If it stays offline, use Take over in Settings › Advanced.`;
      return moved.outcome === "moved"
        ? "The server runs this workspace's automations now."
        : "The server already runs this workspace's automations.";
    }
    case "notesConvert": {
      const run = result as Extract<CliResultByVerb["notesConvert"], { ok: true }>;
      if (run.stopped)
        throw new DohcCliError(
          `${run.stopped} dohc converted ${counted(run.converted, "note", "notes")} before it stopped. Run it again to finish.`,
        );
      const lines = [
        `Converted ${counted(run.converted, "note", "notes")}. ${run.unchanged === 1 ? "1 was" : `${run.unchanged} were`} already converted.`,
        ...(run.sent
          ? []
          : ["dohc could not send them to the server yet. Run it again to send them."]),
      ];
      for (const group of leftNoteGroups(run)) {
        lines.push("", `${group.title} (${group.notes.length}):`);
        for (const note of group.notes)
          lines.push(`  ${lineSafe(note.path)}${note.reason ? `: ${lineSafe(note.reason)}` : ""}`);
      }
      return lines.join("\n");
    }
    case "webhookCreate": {
      const created = result as Extract<CliResultByVerb["webhookCreate"], { ok: true }>;
      const keep = created.webhook.form
        ? `It is a website form address: anyone who loads your page can post to it, and dohc keeps only ${created.webhook.form.fields.map(lineSafe).join(", ")}. dohc shows it once:`
        : "Keep this address secret; dohc shows it once:";
      return `Created ${lineSafe(created.webhook.name)} for ${lineSafe(created.webhook.collectionPath)}. ${keep}
${created.endpointUrl}`;
    }
    case "documentRead": {
      const document = result as CliResultByVerb["documentRead"];
      if (!document.ok) throw new DohcCliError(document.reason);
      return document.markdown;
    }
    case "documentHeld": {
      const held = result as CliResultByVerb["documentHeld"];
      if (!held.ok) throw new DohcCliError(held.reason);
      return JSON.stringify(held.change, null, 2);
    }
    case "collectionSetFields":
      return `Updated ${lineSafe((result as Extract<CliResultByVerb["collectionSetFields"], { ok: true }>).recordPath)}`;
    case "heldNoteChange":
      return JSON.stringify(result, null, 2);
    case "documentEdit":
    case "documentCreate": {
      const document = result as CliResultByVerb["documentEdit" | "documentCreate"];
      if (!document.ok) throw new DohcCliError(document.reason);
      const action =
        "changed" in document ? (document.changed ? "Updated" : "Unchanged") : "Created";
      return `${action} ${document.path}${"warning" in document && document.warning ? `\n${document.warning}` : ""}`;
    }
    case "fileChatStart": {
      const comment = result as CliResultByVerb["fileChatStart"];
      if (!comment.ok) throw new DohcCliError(comment.reason);
      const commented = `Commented on ${lineSafe(comment.path)} in ${lineSafe(comment.threadId)}`;
      return comment.warning ? `${commented}\nwarning: ${lineSafe(comment.warning)}` : commented;
    }
    case "liveKeptEdits": {
      const { keptEdits, pendingShare, pendingShareWhileOpen } = result as Extract<
        CliResultByVerb["liveKeptEdits"],
        { ok: true }
      >;
      const pending = [
        ...pendingShare.map(
          (path) => `${lineSafe(path)} · pending share: the file holds older text`,
        ),
        ...pendingShareWhileOpen.map(
          (path) => `${lineSafe(path)} · pending share: sent once its editor is left`,
        ),
      ];
      if (keptEdits.length === 0 && pending.length === 0) return "No document has kept edits.";
      return [
        ...keptEdits.map((row) =>
          [
            lineSafe(row.path),
            row.storedOn,
            row.recovery,
            ...(row.saveOnly ? ["saveOnly"] : []),
            ...(row.earlier ? ["earlier"] : []),
            lineSafe(row.incident),
          ].join(" · "),
        ),
        ...pending,
      ].join("\n");
    }
    case "saveRecoveryCopy": {
      const saved = result as Extract<CliResultByVerb["saveRecoveryCopy"], { ok: true }>;
      return [
        ...(saved.copyPath === null ? [] : [`Saved ${lineSafe(saved.copyPath)}`]),
        ...(saved.notInNote === 0
          ? []
          : [
              saved.notInNote === 1
                ? "1 kept edit isn't in the note. It's listed at the end of the copy."
                : `${saved.notInNote} kept edits aren't in the note. They're listed at the end of the copy.`,
            ]),
        `Saved ${lineSafe(saved.packagePath)} on this computer`,
        ...(saved.copyPath === null ? ["dohc could not make a readable copy."] : []),
      ].join("\n");
    }
    case "keepOutsideChange": {
      const kept = result as Extract<CliResultByVerb["keepOutsideChange"], { ok: true }>;
      return kept.kept
        ? `Kept the outside change to ${lineSafe(kept.path)} as a copy`
        : `${lineSafe(kept.path)} holds no outside change`;
    }
    case "retryKeptEdits":
      return `Trying again for ${lineSafe((result as Extract<CliResultByVerb["retryKeptEdits"], { ok: true }>).path)}`;
    case "liveDocuments":
      return renderLiveDocuments(result as Extract<CliResultByVerb["liveDocuments"], { ok: true }>);
    case "liveResume": {
      const resumed = result as Extract<CliResultByVerb["liveResume"], { ok: true }>;
      return resumed.already
        ? `${lineSafe(resumed.path)} was already live.`
        : resumed.ended
          ? `${lineSafe(resumed.path)} was moved, deleted or replaced, so live editing stays off. Its pause has ended.`
          : `Resuming live editing for ${lineSafe(resumed.path)}`;
    }
    case "liveStop": {
      const stopped = result as Extract<CliResultByVerb["liveStop"], { ok: true }>;
      const path = lineSafe(stopped.path);
      if (stopped.already)
        return `Live editing for ${path} was already stopped.${stopped.keptEdits === "kept" ? " dohc still keeps edits the server refused. Run kept-edits to check them." : ""}`;
      return stopped.keptEdits === "recovered"
        ? `Stopped live editing for ${path}. dohc wrote your kept edits into the file.`
        : stopped.keptEdits === "kept"
          ? `Stopped live editing for ${path}. dohc still keeps edits the server refused. Run kept-edits to check them.`
          : `Stopped live editing for ${path}`;
    }
    case "stopAgain": {
      const stopped = result as Extract<CliResultByVerb["stopAgain"], { ok: true }>;
      return stopped.keptEdits === "recovered"
        ? `Stopped live editing for ${lineSafe(stopped.path)}. dohc wrote your kept edits into the file.`
        : stopped.keptEdits === "kept"
          ? `dohc still keeps the edits for ${lineSafe(stopped.path)}. Run kept-edits to check them.`
          : `Stopped live editing for ${lineSafe(stopped.path)}`;
    }
    case "link":
      return (result as CliResultByVerb["link"]).link;
    case "groups":
      return renderGroups(result as CliResultByVerb["groups"]);
    case "groupCreate":
      return renderGroups({ groups: [(result as CliResultByVerb["groupCreate"]).group] });
    case "threads":
      return renderThreads(result as CliResultByVerb["threads"]);
    case "watch": {
      const batch = result as CliResultByVerb["watch"];
      return [
        ...batch.messages.map(
          (message) =>
            `${message.threadId}/${message.messageId} ${lineSafe(message.author.displayName)}: ${lineSafe(message.text)}`,
        ),
        `cursor: ${batch.cursor}`,
      ].join("\n");
    }
    case "inbox":
      return renderInbox(result as CliResultByVerb["inbox"]);
    case "notices":
      return renderNotices(result as NoticesResult);
    case "show":
      return renderShowMarkdown(result as CliResultByVerb["show"]);
    case "post":
      return renderPost(result as CliResultByVerb["post"]);
    case "reply":
      return renderReply(result as CliResultByVerb["reply"]);
    case "react":
      return renderReact(result as CliResultByVerb["react"]);
    case "chatDelete": {
      const deleted = result as CliResultByVerb["chatDelete"];
      return `deleted ${deleted.messageId} in ${deleted.threadId}`;
    }
    case "grep":
      return renderGrep(result as CliResultByVerb["grep"], {
        filesWithMatches: options.grepFilesWithMatches ?? false,
        context: options.grepContext ?? 0,
      });
    case "export":
      return renderExport(result as CliResultByVerb["export"]);
    case "historyOperation": {
      const operation = result as CliResultByVerb["historyOperation"];
      if (!operation.ok) return operation.reason;
      const links = operation.links;
      return [
        ...(links
          ? links.state === "updating"
            ? ["Updating links…"]
            : [
                `Link updates committed in History: ${links.documents} documents. Disk writes follow.`,
                ...(links.uncheckedCount
                  ? [
                      `${links.uncheckedCount} linking documents not checked.`,
                      ...links.unchecked.map((path) => `Not checked: ${lineSafe(path)}`),
                    ]
                  : []),
              ]
          : []),
        ...operation.members.map(
          (member) =>
            `${member.momentId} · ${member.operation} · ${member.beforePath ? `${member.beforePath} → ` : ""}${member.path}`,
        ),
        ...(operation.withoutHistory ?? []).map((path) => `${path} · without History`),
        ...(operation.nextCursor ? [`More paths; use --cursor ${operation.nextCursor}`] : []),
      ].join("\n");
    }
    case "historyUndo": {
      const undo = result as CliResultByVerb["historyUndo"];
      if (!undo.ok) return undo.reason;
      return [
        `History: ${undo.tracked.state}`,
        ...undo.restored.map((path) => `Restored ${path}`),
        ...undo.remaining.map(
          (item) =>
            `${item.reason}${item.retry && !item.reason.includes("Undo again to retry") ? " Undo again to retry." : ""}`,
        ),
      ].join("\n");
    }
    case "versionList": {
      const list = result as CliResultByVerb["versionList"];
      if (!list.ok) return list.reason;
      // A parent that isn't in the list shows by its id.
      const names = new Map(list.versions.map((version) => [version.id, version.name]));
      return list.versions
        .map((version) => {
          const parent = version.madeFromVersionId;
          const madeFrom =
            parent === undefined ? "" : ` · made from ${lineSafe(names.get(parent) ?? parent)}`;
          const archived = version.archivedAtMs !== undefined ? " · archived" : "";
          return `${version.id === list.activeVersionId ? "* " : "  "}${lineSafe(version.name)} · ${version.id}${madeFrom}${archived}`;
        })
        .join("\n");
    }
    case "versionCompare": {
      const compare = result as CliResultByVerb["versionCompare"];
      if (!compare.ok) return compare.reason;
      return [
        ...compare.files.map(
          (file) => `${file.status} · ${lineSafe(file.path)}${file.binary ? " · binary" : ""}`,
        ),
        ...(compare.nextAfterPath ? [`More files; use --after ${compare.nextAfterPath}`] : []),
      ].join("\n");
    }
    case "versionConflicts":
    case "versionResolve": {
      const page = result as CliResultByVerb["versionConflicts"];
      if (!page.ok) return page.reason;
      return conflictLines(page).join("\n");
    }
    case "versionCreate": {
      const created = result as CliResultByVerb["versionCreate"];
      return created.ok
        ? `Created and switched to ${lineSafe(created.version.name)} · ${created.version.id}`
        : created.reason;
    }
    case "versionSwitch": {
      const switched = result as CliResultByVerb["versionSwitch"];
      return switched.ok
        ? `Switched to ${lineSafe(switched.version.name)} · ${counted(switched.changedFileCount, "file", "files")} changed`
        : switched.reason;
    }
    case "versionMerge":
    case "versionUpdate": {
      const outcome = result as CliResultByVerb["versionMerge"] | CliResultByVerb["versionUpdate"];
      if (!outcome.ok) return outcome.reason;
      const head =
        verb === "versionUpdate"
          ? `Updated ${lineSafe(outcome.version.name)} from Main`
          : `Merged ${lineSafe(outcome.version.name)} into Main`;
      const skipped =
        "skippedProtectedFileCount" in outcome && outcome.skippedProtectedFileCount > 0
          ? [
              `${counted(outcome.skippedProtectedFileCount, "protected file", "protected files")} changed on both sides kept the version's copy`,
            ]
          : [];
      return [
        `${head} · ${counted(outcome.mergedFileCount, "file", "files")} merged · ${counted(outcome.conflictCount, "conflict", "conflicts")}`,
        ...skipped,
        ...conflictLines(outcome),
      ].join("\n");
    }
    case "versionArchive": {
      const archive = result as CliResultByVerb["versionArchive"];
      if (!archive.ok) return archive.reason;
      return `${archive.archived ? "Archived" : "Restored"} ${lineSafe(archive.version.name)} · ${archive.version.id}`;
    }
    case "moments":
      return renderMoments(result as CliResultByVerb["moments"]);
    case "moment":
      return renderMoment(result as CliResultByVerb["moment"], options.momentSide ?? "after");
    case "automationRuns":
      return renderAutomationRuns(result as AutomationRunsResult);
    case "automationRun":
      return renderAutomationRun(result as AutomationRunResult);
    case "automationRetry":
    case "chatRetry":
      return "queued";
    case "automationPress":
      return renderAutomationPress(
        result as Extract<CliResultByVerb["automationPress"], { ok: true }>,
      );
    case "workspaceSearch":
      return renderWorkspaceSearch(result as CliResultByVerb["workspaceSearch"]);
    case "planUndoAgentRun":
      return renderPlanUndoAgentRun(result as CliResultByVerb["planUndoAgentRun"]);
    case "undoAgentRun":
      return renderUndoAgentRun(result as Extract<CliResultByVerb["undoAgentRun"], { ok: true }>);
    case "inboxList": {
      const list = result as CliResultByVerb["inboxList"];
      if (!list.exists || list.items.length === 0) return "Inbox is empty.";
      const lines = list.items.map((item) => {
        const parts = [
          `[${item.status ?? "New"}]`,
          lineSafe(item.title || item.path),
          item.path,
          ...(item.source ? [item.source] : []),
          ...(item.received ? [item.received] : []),
        ];
        return parts.join(" · ");
      });
      if (list.hasMore) lines.push("More items exist; raise --limit to see them.");
      return lines.join("\n");
    }
    case "inboxAdd": {
      const added = result as CliResultByVerb["inboxAdd"];
      return added.ok ? `Captured ${lineSafe(added.title)} · ${added.path}` : added.reason;
    }
    case "inboxArchive": {
      const archived = result as CliResultByVerb["inboxArchive"];
      return archived.ok ? `Archived ${archived.path}` : archived.reason;
    }
    case "inboxMove": {
      const moved = result as CliResultByVerb["inboxMove"];
      if (!moved.ok) return moved.reason;
      const lines = [
        `Moved ${moved.fromPath} → ${moved.toPath}${moved.operationId ? ` · operation ${moved.operationId}` : ""}`,
      ];
      for (const attachment of moved.attachments) {
        lines.push(
          `Moved ${attachment.fromPath} → ${attachment.toPath}${attachment.operationId ? ` · operation ${attachment.operationId}` : ""}`,
        );
      }
      return lines.join("\n");
    }
    case "linksConnections": {
      const graph = result as CliResultByVerb["linksConnections"];
      if (graph.scope === "share-omitted")
        return "Connections are kept only in the original workspace. Open it to continue.";
      const names = new Map(graph.nodes.map((node) => [node.id, lineSafe(node.title)]));
      const lines = graph.edges.map(
        (edge) =>
          `${names.get(edge.source) ?? lineSafe(edge.source)} → ${names.get(edge.target) ?? lineSafe(edge.target)} · ${edge.kind}${edge.approval ? ` · ${edge.approval}` : ""}`,
      );
      if (!graph.complete) lines.push("More connections exist than fit in one answer.");
      return lines.join("\n") || "No connections in this workspace.";
    }
    case "memberAppsList": {
      const list = result as CliResultByVerb["memberAppsList"];
      const lines = list.apps.map((app) =>
        [
          app.publicationId,
          lineSafe(app.name),
          app.kind === "workspace" ? "official" : `by ${lineSafe(app.authorName ?? "a member")}`,
          ...(app.consent === "none" ? ["not allowed yet"] : []),
          ...(app.consent === "changed" ? ["changed since you allowed it"] : []),
          ...(app.url ? [app.url] : []),
        ].join(" · "),
      );
      if (list.membersCanShare !== undefined)
        lines.push(`Members can share apps: ${list.membersCanShare ? "on" : "off"}`);
      if (list.nextCursor) lines.push(`More apps: --cursor ${list.nextCursor}`);
      return lines.join("\n") || "No apps in this workspace.";
    }
    case "memberAppInspect": {
      const app = result as CliResultByVerb["memberAppInspect"];
      return [
        `${lineSafe(app.name)} by ${lineSafe(app.authorName ?? "a member")}`,
        ...app.collections.flatMap((collection) => [
          `${lineSafe(collection.name)} (${collection.access})`,
          ...collection.operations.map(
            (operation) =>
              `  ${lineSafe(operation.name)}${operation.readOnly ? "" : " · changes data"}`,
          ),
        ]),
        ...app.source.map((file) => `${lineSafe(file.path)} · ${file.byteLength} bytes`),
      ].join("\n");
    }
    case "memberAppSource": {
      const file = result as CliResultByVerb["memberAppSource"];
      return file.text ?? `${lineSafe(file.path)} · ${file.byteLength} bytes, not shown as text`;
    }
    case "memberAppShare": {
      const shared = result as Extract<CliResultByVerb["memberAppShare"], { ok: true }>;
      return `Shared ${shared.slug} with the workspace's members · ${shared.publicationId}`;
    }
    case "memberAppFork":
      return `Copied into ${lineSafe((result as Extract<CliResultByVerb["memberAppFork"], { ok: true }>).personalApp)} in your Personal app folder`;
    case "memberAppPromote":
      return `Copied into ${lineSafe((result as Extract<CliResultByVerb["memberAppPromote"], { ok: true }>).folder)}. Publish it with Review app.`;
    case "memberAppWithdraw":
      return `Withdrew ${(result as Extract<CliResultByVerb["memberAppWithdraw"], { ok: true }>).publicationId}`;
    case "memberAppSharing":
      return `Members can share apps: ${(result as Extract<CliResultByVerb["memberAppSharing"], { ok: true }>).membersCanShare ? "on" : "off"}`;
    default:
      return JSON.stringify(result, null, 2);
  }
}

function renderPlanUndoAgentRun(result: CliResultByVerb["planUndoAgentRun"]): string {
  if (result.policyUnreadable?.length) {
    return `Could not read workspace rules (${result.policyUnreadable.map(lineSafe).join(", ")}).`;
  }
  const lines: string[] = [];
  if (result.restorable.length === 0 && result.skipped.length === 0) {
    lines.push("No file changes found for this agent run on the active version.");
  } else {
    lines.push(
      `${counted(result.restorable.length, "file", "files")} can be undone · ${counted(result.skipped.length, "file", "files")} skipped`,
    );
    for (const item of result.restorable) {
      lines.push(
        `  undo (${item.action === "delete" ? "remove created file" : "restore"}): ${lineSafe(item.path)}`,
      );
    }
    for (const item of result.skipped) {
      lines.push(`  skip: ${lineSafe(item.path)} (${lineSafe(item.detail)})`);
    }
    if (result.restorable.length > 0) {
      lines.push(`Plan token: ${lineSafe(result.planToken)}`);
    }
  }
  if (result.truncated) {
    lines.push(
      `Note: checked the latest ${AGENT_RUN_SCAN_MAX_PAGES} History pages (${counted(result.scannedChanges, "change", "changes")} on this version). Older history was not checked.`,
    );
  }
  return lines.join("\n");
}

function renderUndoAgentRun(
  result: Extract<CliResultByVerb["undoAgentRun"], { ok: true }>,
): string {
  if (result.policyUnreadable?.length) {
    return `Could not read workspace rules (${result.policyUnreadable.map(lineSafe).join(", ")}).`;
  }
  const lines: string[] = [
    `${counted(result.restored.length, "file", "files")} undone · ${counted(result.skipped.length, "file", "files")} skipped · ${counted(result.failed.length, "file", "files")} failed`,
  ];
  for (const item of result.restored) {
    lines.push(`  ${item.restored === "deleted" ? "removed" : "restored"}: ${lineSafe(item.path)}`);
  }
  for (const item of result.skipped) {
    lines.push(`  skipped: ${lineSafe(item.path)} (${lineSafe(item.detail)})`);
  }
  for (const item of result.failed) {
    lines.push(`  failed: ${lineSafe(item.path)} (${lineSafe(item.detail)})`);
  }
  return lines.join("\n");
}

function renderWorkspaceSearch(result: CliResultByVerb["workspaceSearch"]): string {
  const lines: string[] = [];
  if (result.results.length === 0) {
    lines.push("No matching pages, Collections, records, or chats.");
  } else {
    for (const hit of result.results) {
      const tag =
        hit.kind === "collection" && hit.collectionKind === "transactional" ? "dataset" : hit.kind;
      const location =
        hit.path ??
        hit.collectionPath ??
        hit.datasetPath ??
        (hit.channelName && hit.threadId
          ? `#${hit.channelName} (${hit.threadId})`
          : (hit.threadId ?? hit.id));
      lines.push(`[${tag}] ${lineSafe(hit.title)} — ${lineSafe(location)}`);
      if (hit.matchedFields && hit.matchedFields.length > 0) {
        const fields = hit.matchedFields
          .map((field) => `${lineSafe(field.name)}=${lineSafe(field.value)}`)
          .join(" · ");
        lines.push(`  fields: ${fields}`);
      }
      if (hit.snippet.trim().length > 0) {
        lines.push(`  ${lineSafe(hit.snippet)}`);
      }
      if (hit.related.length > 0) {
        const links = hit.related
          .map((edge) => {
            const arrow = edge.direction === "out" ? "→" : "←";
            const label = edge.field ? `${edge.edge}:${edge.field}` : edge.edge;
            return `${arrow} [${edge.kind}] ${lineSafe(edge.title)} (${label})`;
          })
          .join(", ");
        lines.push(`  related: ${links}`);
      }
    }
  }
  if (result.neighbors.length > 0) {
    lines.push("");
    lines.push("Connected:");
    for (const neighbor of result.neighbors) {
      const location = neighbor.path ?? neighbor.collectionPath ?? neighbor.threadId ?? neighbor.id;
      const via = neighbor.via
        .map((step) => {
          const label = step.field ? `${step.edge}:${step.field}` : step.edge;
          return `${step.direction === "out" ? "from" : "to"} ${lineSafe(step.fromTitle)} (${label})`;
        })
        .join("; ");
      lines.push(
        `  [${neighbor.kind}] ${lineSafe(neighbor.title)} — ${lineSafe(location)} (via ${via})`,
      );
    }
  }
  const notices: string[] = [];
  if (result.indexBuilding) notices.push("index is still building");
  if (result.policyDegraded) {
    notices.push("visibility policy could not be read; filtered files excluded");
  }
  if (!result.mountsCovered) {
    notices.push("mounted shared folders under shared-with-me/ are not searched");
  }
  if (result.sharedChannelRowsUncovered > 0) {
    notices.push(
      `${counted(result.sharedChannelRowsUncovered, "shared channel", "shared channels")} could not be refreshed`,
    );
  }
  if (result.truncated) notices.push("output truncated to byte budget");
  if (!result.complete && notices.length === 0) notices.push("partial coverage");
  if (notices.length > 0) {
    lines.push("");
    lines.push(`Note: ${notices.join("; ")}.`);
  }
  return lines.join("\n");
}
