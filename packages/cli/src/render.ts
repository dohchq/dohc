import type {
  CliGrepContextMessage,
  CliGrepMatch,
  CliResultByVerb,
} from "./protocol";
import { renderAuthorDisplayName } from "./chatIdentity";
import { renderThreadMarkdown } from "./threadMarkdown";
import { DohcCliError } from "./errors";
import { formatStoredBytes } from "./account";

type GroupsResult = CliResultByVerb["groups"];
type ThreadsResult = CliResultByVerb["threads"];
type InboxResult = CliResultByVerb["inbox"];
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
  return renderThreadMarkdown(result);
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
  message: CliGrepContextMessage | Pick<CliGrepMatch, "messageId" | "author" | "createdAtMs" | "text">,
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
  if (result.hasMore) lines.push(`${result.totalAvailable - result.count} more; raise --limit to list them`);
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
    throw new DohcCliError(`${change.path} is binary at ${change.id}; history show prints text only`);
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
  const lines = result.runs.map((run) => [
    run.run,
    dateTime(run.createdAtMs),
    runStateText(run),
    triggerText(run.trigger),
    countLabel(run.changes, "change"),
    ...(run.error === null ? [] : [lineSafe(run.error)]),
  ].join(" · "));
  return [...lines, ...(result.next === null ? [] : [`Older runs: --page ${lineSafe(result.next)}`])].join("\n");
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
      : run.failedStep === null ? [] : [`Try again resumes at step ${run.failedStep}.`]),
    ...run.steps.flatMap((step) => [`step ${step.step}:`, ...step.changes.map((change) => `  ${changeText(change)}`)]),
  ].join("\n");
}

function renderAutomationPress(result: Extract<CliResultByVerb["automationPress"], { ok: true }>): string {
  if ("relayed" in result) return "sent to the owner's computer, which runs it";
  const ran = result.outcome === null ? `started run ${result.run}` : `run ${result.run} ${result.outcome}`;
  return [
    result.error === null ? ran : `${ran}: ${lineSafe(result.error)}`,
    ...(result.waiting === null ? [] : [result.waiting]),
  ].join("\n");
}

export function renderCliResult<Verb extends keyof CliResultByVerb>(
  verb: Verb,
  result: CliResultByVerb[Verb],
  options: { grepFilesWithMatches?: boolean; grepContext?: number; momentSide?: "before" | "after" } = {},
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
    case "chatLinks":
    case "chatFileMentions":
    case "linksEdges":
    case "linksIn":
    case "linksResolve":
    case "shareCopy":
    case "accessRefresh":
    case "accessObject":
    case "accessSharing":
      return JSON.stringify(result, null, 2);
    case "automationList":
    case "automationSwitch":
      return JSON.stringify(result, null, 2);
    case "documentRead": {
      const document = result as CliResultByVerb["documentRead"];
      if (!document.ok) throw new DohcCliError(document.reason);
      return document.markdown;
    }
    case "documentEdit":
    case "documentCreate": {
      const document = result as CliResultByVerb["documentEdit" | "documentCreate"];
      if (!document.ok) throw new DohcCliError(document.reason);
      const action = "changed" in document ? document.changed ? "Updated" : "Unchanged" : "Created";
      return `${action} ${document.path}${"warning" in document && document.warning ? `\n${document.warning}` : ""}`;
    }
    case "fileChatStart": {
      const comment = result as CliResultByVerb["fileChatStart"];
      if (!comment.ok) throw new DohcCliError(comment.reason);
      const commented = `Commented on ${lineSafe(comment.path)} in ${lineSafe(comment.threadId)}`;
      return comment.warning ? `${commented}\nwarning: ${lineSafe(comment.warning)}` : commented;
    }
    case "liveKeptEdits": {
      const { keptEdits } = result as Extract<CliResultByVerb["liveKeptEdits"], { ok: true }>;
      if (keptEdits.length === 0) return "No document has kept edits.";
      return keptEdits.map(row => `${lineSafe(row.path)} · ${row.storedOn} · ${row.recovery} · ${lineSafe(row.incident)}`).join("\n");
    }
    case "saveRecoveryCopy": {
      const saved = result as Extract<CliResultByVerb["saveRecoveryCopy"], { ok: true }>;
      return [
        ...(saved.copyPath === null ? [] : [`Saved ${lineSafe(saved.copyPath)}`]),
        `Saved ${lineSafe(saved.packagePath)}`,
        ...(saved.copyPath === null ? ["dohc could not make a readable copy."] : []),
      ].join("\n");
    }
    case "retryKeptEdits":
      return `Trying again for ${lineSafe((result as Extract<CliResultByVerb["retryKeptEdits"], { ok: true }>).path)}`;
    case "stopAgain": {
      const stopped = result as Extract<CliResultByVerb["stopAgain"], { ok: true }>;
      return stopped.keptEdits === "recovered" ? `Stopped live editing for ${lineSafe(stopped.path)}. dohc wrote your kept edits into the file.`
        : stopped.keptEdits === "kept" ? `dohc still keeps the edits for ${lineSafe(stopped.path)}. Run kept-edits to check them.`
        : `Stopped live editing for ${lineSafe(stopped.path)}`;
    }
    case "groups":
      return renderGroups(result as CliResultByVerb["groups"]);
    case "threads":
      return renderThreads(result as CliResultByVerb["threads"]);
    case "inbox":
      return renderInbox(result as CliResultByVerb["inbox"]);
    case "show":
      return renderShowMarkdown(result as CliResultByVerb["show"]);
    case "post":
      return renderPost(result as CliResultByVerb["post"]);
    case "reply":
      return renderReply(result as CliResultByVerb["reply"]);
    case "react":
      return renderReact(result as CliResultByVerb["react"]);
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
      return [...(links ? links.state === "updating" ? ["Updating links…"]
        : [`Link updates committed in History: ${links.documents} documents. Disk writes follow.`,
          ...(links.uncheckedCount ? [`${links.uncheckedCount} linking documents not checked.`, ...links.unchecked.map(path => `Not checked: ${lineSafe(path)}`)] : [])] : []),
        ...operation.members.map(member => `${member.momentId} · ${member.operation} · ${member.beforePath ? `${member.beforePath} → ` : ""}${member.path}`),
        ...(operation.withoutHistory ?? []).map(path => `${path} · without History`),
        ...(operation.nextCursor ? [`More paths; use --cursor ${operation.nextCursor}`] : [])].join("\n");
    }
    case "historyUndo": {
      const undo = result as CliResultByVerb["historyUndo"];
      if (!undo.ok) return undo.reason;
      return [`History: ${undo.tracked.state}`, ...undo.restored.map(path => `Restored ${path}`),
        ...undo.remaining.map(item => `${item.reason}${item.retry && !item.reason.includes("Undo again to retry") ? " Undo again to retry." : ""}`)].join("\n");
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
      return "queued";
    case "automationPress":
      return renderAutomationPress(result as Extract<CliResultByVerb["automationPress"], { ok: true }>);
    default:
      return JSON.stringify(result, null, 2);
  }
}
