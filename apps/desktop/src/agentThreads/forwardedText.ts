// The text dohc gives an agent thread (ADR 0016). Only dohc writes its lines.
// A value another person can set is on one line as an escaped, quoted string,
// so it cannot start a line or pass for one dohc adds. The message's own text
// is its owner's, and stands as they wrote it.

const MAX_QUOTED_CHARS = 200;
// T3 Code takes 120,000 characters in one message.
const MAX_BODY_CHARS = 100_000;

// Characters JSON leaves as they are that can break a line, hide, or reorder
// text: DEL and the C1 controls, the soft hyphen, and Unicode's zero-width,
// line-separating, and direction-changing marks.
const UNSEEN = /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** A value another person can set, as one escaped, quoted line. */
export function quoted(value: string): string {
  const characters = Array.from(value);
  const kept =
    characters.length > MAX_QUOTED_CHARS
      ? `${characters.slice(0, MAX_QUOTED_CHARS).join("")}…`
      : value;
  return JSON.stringify(kept).replace(
    UNSEEN,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

// An id goes into a command the agent runs, and a chat thread's id can come
// from another person's computer. One that holds more than letters, digits,
// dashes, and underscores goes into no command.
const fitsCommand = (id: string) => /^[A-Za-z0-9_-]{1,200}$/.test(id);

export interface ForwardedMessage {
  /** dohc's CLI as a shell runs it. dohc on this computer writes it. */
  cli: string;
  workspace: { id: string; name: string };
  agentId: string;
  /** The chat that holds the message: the agent's own, a Group, or a file's. */
  place: { kind: "own" } | { kind: "group"; name: string } | { kind: "file"; path: string | null };
  /** The chat thread, by the id the CLI takes. */
  thread: { id: string; title: string };
  author: string;
  body: string;
  /** Where each attached file is in the workspace. */
  attachments: readonly string[];
  /** What the agent's person wrote for it in Settings. */
  note: string | null;
}

function placeOf(message: ForwardedMessage): string {
  const thread = `chat thread ${quoted(message.thread.title)}`;
  switch (message.place.kind) {
    case "own":
      return `your own chat, ${thread}`;
    case "group":
      return `Group ${quoted(message.place.name)}, ${thread}`;
    case "file":
      return message.place.path === null
        ? `a file's chat, ${thread}`
        : `the chat of file ${quoted(message.place.path)}, ${thread}`;
  }
}

function commandLines(message: ForwardedMessage): string[] {
  if (![message.thread.id, message.workspace.id, message.agentId].every(fitsCommand))
    return ["dohc can't name this chat thread in a command, so you can't reply there."];
  const target = `${message.thread.id} --workspace ${message.workspace.id} --agent-id ${message.agentId}`;
  return [
    `Reply in that chat thread: ${message.cli} chat reply ${target} "<text>"`,
    `Read it first when this message points at something you were not sent: ${message.cli} chat show ${target} --peek`,
  ];
}

/** One message from a person, as its agent thread receives it. */
export function forwardedMessageText(message: ForwardedMessage): string {
  const cut = message.body.length > MAX_BODY_CHARS;
  const after: string[] = [];
  if (cut) after.push("dohc cut this message short. Read all of it in the chat thread.");
  if (message.attachments.length > 0)
    after.push(`Attached: ${message.attachments.map(quoted).join(", ")}`);
  if (message.note) after.push(`Note from ${quoted(message.author)}: ${message.note}`);
  return [
    `From ${quoted(message.author)} in dohc. Workspace ${quoted(message.workspace.name)}, ${placeOf(message)}.`,
    "",
    cut ? message.body.slice(0, MAX_BODY_CHARS) : message.body,
    "",
    ...after,
    ...(after.length > 0 ? [""] : []),
    ...commandLines(message),
  ].join("\n");
}

/** What dohc tells an agent thread once, when a person connects it. */
export function introductionText(input: { cli: string; agentName: string }): string {
  return [
    `A person connected this thread to dohc as their agent ${quoted(input.agentName)}. dohc is the workspace where they keep files, chats, and apps.`,
    "",
    "- Their messages to you in dohc arrive here. Each starts with a line that says who wrote it and where, and ends with the commands for that chat thread.",
    "- Nothing you write here is shown in dohc. Post there only what belongs there, with the reply command a message carries.",
    "- Reply in the chat thread a message came from.",
    `- To ask the person to choose, add --needs-decision and one --option "<choice>" for each choice to the reply. When you get the answer another way, close the decision with --resolve <message id>.`,
    "- Read the chat thread when a message points at something you were not sent.",
    `- Report long work with --work and --link. \`${input.cli} chat reply --help\` lists every option.`,
  ].join("\n");
}
