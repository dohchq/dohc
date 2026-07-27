import type { z } from "zod";
import type {
  channelsResultSchema,
  CliGrepContextMessage,
  CliGrepMatch,
  CliResultByVerb,
  exportResultSchema,
  inboxResultSchema,
  postResultSchema,
  reactResultSchema,
  replyResultSchema,
  showResultSchema,
  threadsResultSchema,
} from "./protocol";
import { renderAuthorDisplayName } from "./chatIdentity";
import { renderThreadMarkdown } from "./threadMarkdown";

export type ChannelsResult = z.infer<typeof channelsResultSchema>;
export type ThreadsResult = z.infer<typeof threadsResultSchema>;
export type InboxResult = z.infer<typeof inboxResultSchema>;
export type ShowResult = z.infer<typeof showResultSchema>;
export type PostResult = z.infer<typeof postResultSchema>;
export type ReplyResult = z.infer<typeof replyResultSchema>;
export type ReactResult = z.infer<typeof reactResultSchema>;
export type ExportResult = z.infer<typeof exportResultSchema>;

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

export function renderChannels(result: ChannelsResult): string {
  return result.channels
    .map((channel) => {
      const name = channel.kind === "agent" ? "my-agent" : lineSafe(channel.name);
      return `${name} · #${channel.slug} · ${channel.kind} · ${channel.id}`;
    })
    .join("\n");
}

export function renderThreads(result: ThreadsResult): string {
  const lines = [`#${result.channel.slug} · ${result.channel.id}`];
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
      `[unread] · ${thread.id} · #${thread.channel.slug} · ${lineSafe(thread.title)} · ${countLabel(thread.commentCount, "comment")} · open decisions: ${decisionCount(thread.openDecisionCount)}`,
    );
  }
  for (const mention of result.mentions) {
    lines.push(
      `@mention · #${mention.channel.slug} · ${mention.threadId} · ${mention.messageId} · ${lineSafe(renderAuthorDisplayName(mention.author))} · ${dateOnly(mention.createdAtMs)}  ${lineSafe(mention.text)}`,
    );
  }
  return lines.join("\n");
}

export function renderPost(result: PostResult): string {
  const posted = `posted ${result.threadId} ${result.messageId} in #${result.channel.slug}`;
  return result.warning ? `${posted}\nwarning: ${result.warning}` : posted;
}

export function renderReply(result: ReplyResult): string {
  const details = [`replied ${result.threadId} ${result.messageId}`];
  if (result.parentMessageId) details.push(`to ${result.parentMessageId}`);
  if (result.resolvedMessageId) details.push(`resolved ${result.resolvedMessageId}`);
  const replied = details.join(" · ");
  return result.warning ? `${replied}\nwarning: ${result.warning}` : replied;
}

export function renderReact(result: ReactResult): string {
  return `${result.state} ${result.emoji} on ${result.messageId} in ${result.threadId}`;
}

function renderGrepLine(
  match: Pick<CliGrepMatch, "channel" | "threadId">,
  message: CliGrepContextMessage | Pick<CliGrepMatch, "messageId" | "author" | "createdAtMs" | "text">,
  context: boolean,
): string {
  const contextMarker = context ? "- " : "";
  return `#${match.channel.slug} ${match.threadId} ${message.messageId} ${lineSafe(renderAuthorDisplayName(message.author))} ${dateOnly(message.createdAtMs)}  ${contextMarker}${lineSafe(message.text)}`;
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

export function renderExport(result: ExportResult): string {
  return result.files.map((file) => `${file.threadId}  ${file.path}`).join("\n");
}

export function renderCliResult<Verb extends keyof CliResultByVerb>(
  verb: Verb,
  result: CliResultByVerb[Verb],
  options: { grepFilesWithMatches?: boolean; grepContext?: number } = {},
): string {
  switch (verb) {
    case "channels":
      return renderChannels(result as CliResultByVerb["channels"]);
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
    default:
      return JSON.stringify(result, null, 2);
  }
}
