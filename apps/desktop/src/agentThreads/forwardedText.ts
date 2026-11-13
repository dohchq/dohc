// The text dohc gives an agent thread (ADR 0016). Only dohc writes its lines.
// A value another person can set is on one line as an escaped, quoted string,
// so it cannot start a line or pass for one dohc adds. The message's own text
// and the note are its owner's, and stand as they wrote them.

const MAX_QUOTED_CHARS = 200;
// T3 Code takes 120,000 characters in one message. These leave room for the
// lines dohc adds, each value at its longest.
const MAX_BODY_CHARS = 80_000;
const MAX_NOTE_CHARS = 4_000;

// A character a reader can see: a letter, mark, number, punctuation, symbol,
// or space. Everything else is escaped: controls, line separators, and the
// marks that hide or reorder text.
const SEEN = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}]$/u;
// Characters in those classes that Unicode says to draw nothing for, so text
// can hide in them: the Hangul fillers, the variation selectors, and others.
const UNDRAWN = /\p{Default_Ignorable_Code_Point}/u;

function shown(character: string): string {
  const code = character.codePointAt(0)!;
  if (SEEN.test(character) && !UNDRAWN.test(character)) return character;
  return code > 0xffff ? `\\u{${code.toString(16)}}` : `\\u${code.toString(16).padStart(4, "0")}`;
}

/** A value another person can set, as one escaped, quoted line. */
export function quoted(value: string, most = MAX_QUOTED_CHARS): string {
  const characters = Array.from(value);
  const kept = characters.length > most ? `${characters.slice(0, most).join("")}…` : value;
  return Array.from(JSON.stringify(kept), shown).join("");
}

// An id goes into a command the agent runs, and a chat thread's id can come
// from another person's computer. One that starts with a dash, or holds more
// than letters, digits, dashes, and underscores, goes into no command.
const fitsCommand = (id: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id);

export interface ForwardedMessage {
  /** dohc's CLI as a shell runs it. dohc on this computer writes it. */
  cli: string;
  /** The folder that holds that program, for a shell that does not find it. */
  cliFolder: string | null;
  workspace: { id: string; name: string };
  agentId: string;
  /** The chat that holds the message: the agent's own, a Group, or a file's. */
  place: { kind: "own" } | { kind: "group"; name: string } | { kind: "file" };
  /** The chat thread, by the id the CLI takes. */
  thread: { id: string; title: string };
  author: string;
  body: string;
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
      return `a file's chat, ${thread}`;
  }
}

// A folder's place is this computer's own, and as long as the system allows.
const MAX_FOLDER_CHARS = 1024;
const whereCliIs = (input: Pick<ForwardedMessage, "cli" | "cliFolder">): string[] =>
  input.cliFolder === null
    ? []
    : [
        `When your shell does not find ${input.cli}, run it from the folder ${quoted(input.cliFolder, MAX_FOLDER_CHARS)}.`,
      ];

// The reply's text goes in on stdin, so no shell reads it.
function commandLines(message: ForwardedMessage): string[] {
  if (![message.thread.id, message.workspace.id, message.agentId].every(fitsCommand))
    return ["dohc can't name this chat thread in a command, so you can't reply there."];
  const target = `${message.thread.id} --workspace ${message.workspace.id} --agent-id ${message.agentId}`;
  return [
    ...whereCliIs(message),
    `Reply in that chat thread, with your text on stdin: ${message.cli} chat reply ${target} -`,
    `Read it first when this message points at something you were not sent, such as a file: ${message.cli} chat show ${target} --peek`,
  ];
}

/** One message from a person, as its agent thread receives it. */
export function forwardedMessageText(message: ForwardedMessage): string {
  const cut = message.body.length > MAX_BODY_CHARS;
  const after: string[] = [];
  if (cut) after.push("dohc cut this message short. Read all of it in the chat thread.");
  if (message.note)
    after.push(`Note from ${quoted(message.author)}: ${message.note.slice(0, MAX_NOTE_CHARS)}`);
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
export function introductionText(input: {
  cli: string;
  cliFolder: string | null;
  agentName: string;
}): string {
  return [
    `A person connected this thread to dohc as their agent ${quoted(input.agentName)}. dohc is the workspace where they keep files, chats, and apps.`,
    "",
    "- Their messages to you in dohc arrive here. Each starts with a line that says who wrote it and where, and ends with the commands for that chat thread.",
    "- Nothing you write here is shown in dohc. Post there only what belongs there, with the reply command a message carries.",
    "- Reply in the chat thread a message came from. Give the reply's text on stdin, never as an argument, so no shell reads what other people wrote.",
    `- To ask the person to choose, add --needs-decision and one --option "<choice>" for each choice to the reply. When you get the answer another way, close the decision with --resolve <message id>.`,
    "- Read the chat thread when a message points at something you were not sent.",
    `- Report long work with --work and --link. \`${input.cli} chat reply --help\` lists every option.`,
    ...whereCliIs(input).map((line) => `- ${line}`),
  ].join("\n");
}
