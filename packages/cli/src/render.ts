import type {
  CliGrepContextMessage,
  CliGrepMatch,
  CliResultByVerb,
} from "./protocol";
import { renderAuthorDisplayName } from "./chatIdentity";
import { renderThreadMarkdown } from "./threadMarkdown";
import { DohcCliError } from "./errors";

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
      const name = group.kind === "agent" ? "my-agent" : lineSafe(group.name);
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
  const lines = result.changes.map((change) => {
    const author = change.author?.kind === "agent" ? ` · agent ${change.author.agentId}` : "";
    const summary = change.summary ? ` · ${lineSafe(change.summary)}` : "";
    return `${change.id} · ${dateTime(change.recordedAtMs)} · ${change.operation} · ${change.path}${author}${summary}`;
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

export function renderCliResult<Verb extends keyof CliResultByVerb>(
  verb: Verb,
  result: CliResultByVerb[Verb],
  options: { grepFilesWithMatches?: boolean; grepContext?: number; momentSide?: "before" | "after" } = {},
): string {
  switch (verb) {
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
    case "moments":
      return renderMoments(result as CliResultByVerb["moments"]);
    case "moment":
      return renderMoment(result as CliResultByVerb["moment"], options.momentSide ?? "after");
    default:
      return JSON.stringify(result, null, 2);
  }
}
