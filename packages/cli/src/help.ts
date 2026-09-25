import { CLI_COMMANDS, DASH_RULE, GLOBAL_FLAGS, type CliCommandSpec, type CliFlag, type CliHelpRequest, type CliVerbSpec } from "./args";

const WIDTH = 80;
const where = "Run dohc inside a workspace folder while the dohc app is open.";

/** Wraps text at WIDTH. The first line starts with `first`; later lines align under its text. */
function wrap(text: string, first = ""): string[] {
  const indent = " ".repeat(first.length);
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(" ")) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = indent + word;
    } else {
      line = empty ? line + word : `${line} ${word}`;
    }
    empty = false;
  }
  return [...lines, line];
}

function table(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows.flatMap(([name, text]) => wrap(text, `  ${name.padEnd(width)}   `));
}

function flagRows(flags: readonly CliFlag[]): string[] {
  return table(flags.map((flag) => [flag.value ? `${flag.name} <${flag.value}>` : flag.name, flag.text]));
}

function paragraph(lines: readonly string[]): string[] {
  return lines.flatMap((line) => wrap(line));
}

function fieldLines(verb: CliVerbSpec): string[] {
  if (!verb.fields) return [];
  const required: string[] = [];
  const optional: string[] = [];
  for (const [name, schema] of Object.entries(verb.fields)) {
    if (name === "action") continue;
    const isOptional = schema.safeParse(undefined).success && !verb.required?.includes(name);
    (isOptional ? optional : required).push(name);
  }
  return [
    `Fields: ${required.join(", ")}`,
    ...(optional.length > 0 ? [`Optional fields: ${optional.join(", ")}`] : []),
  ];
}

function topHelp(): string[] {
  const commands = Object.entries(CLI_COMMANDS);
  const width = Math.max(...commands.map(([name]) => name.length));
  return [
    "Usage: dohc <command> <verb> [arguments] [options]",
    "",
    where,
    "",
    "Commands:",
    ...commands.flatMap(([name, command]) => [
      ...wrap(command.summary, `  ${name.padEnd(width)}   `),
      ...wrap(Object.keys(command.verbs).join(", "), " ".repeat(width + 5)),
    ]),
    "",
    "Options:",
    ...flagRows(GLOBAL_FLAGS),
    "",
    "Run dohc <command> --help to see what each verb does.",
  ];
}

function commandHelp(name: string, command: CliCommandSpec): string[] {
  return [
    `Usage: dohc ${name} <verb> [arguments] [options]`,
    "",
    command.summary,
    "",
    "Verbs:",
    ...table(Object.entries(command.verbs).map(([verbName, verb]) => [verbName, verb.summary])),
    "",
    ...paragraph([where, ...command.notes]),
    "",
    "Options:",
    ...flagRows(GLOBAL_FLAGS),
    "",
    `Run dohc ${name} <verb> --help to see its arguments and options.`,
  ];
}

function verbHelp(commandName: string, command: CliCommandSpec, name: string, verb: CliVerbSpec): string[] {
  const usage = ["dohc", commandName, name, verb.operands, "[options]"].filter(Boolean).join(" ");
  const details = [...fieldLines(verb), ...(verb.notes ?? []), ...(verb.freeText ? [`Put ${DASH_RULE}.`] : [])];
  return [
    `Usage: ${usage}`,
    "",
    verb.summary,
    ...(details.length > 0 ? ["", ...paragraph(details)] : []),
    "",
    ...paragraph([where, ...command.notes]),
    "",
    "Options:",
    ...flagRows([...(verb.flags ?? []), ...GLOBAL_FLAGS]),
  ];
}

export function renderCliHelp(request: CliHelpRequest): string {
  const [commandName, verbName] = request.help;
  const command = commandName === undefined ? undefined : CLI_COMMANDS[commandName];
  const verb = verbName === undefined ? undefined : command?.verbs[verbName];
  const lines = !commandName || !command
    ? topHelp()
    : !verbName || !verb
      ? commandHelp(commandName, command)
      : verbHelp(commandName, command, verbName, verb);
  return `${lines.join("\n")}\n`;
}
