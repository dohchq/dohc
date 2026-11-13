// Writes the declared operations' entries in the main inventories from their
// declarations. Run `pnpm write:operation-pins` after adding or changing a
// declaration, then review the diff. Other entries stay as reviewed by hand.
// channelKeys.main.json lists CHANNELS keys, which no declaration adds.
// Removing a declaration leaves its entries for you to delete.
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { renderCliHelp } from "@dohc/cli/help";
import { CLI_CAPABILITIES, DECLARED_VERBS } from "@dohc/cli/protocol";
import { advertisedCapabilityTools } from "@dohc/mcp/capability-exposure-fixture";
import { declaredRows, type OperationDefinition } from "./operationTable";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const here = (name: string) => new URL(name, import.meta.url);
const read = (path: URL) => readFileSync(path, "utf8");
const readJson = <T>(path: URL) => JSON.parse(read(path)) as T;
const writeJson = (path: URL, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");

const operations = Object.values(DECLARED_VERBS);
const family = Object.fromEntries(operations.map(operation => [operation.cli.verb, operation])) as Record<string, (typeof operations)[number]>;
const rows: OperationDefinition[] = Object.values(declaredRows(family, z.string()));
const labels = operations.map(({ cli }) => cli.command.join(" "));
const groups: string[] = [...new Set(operations.map(({ cli }) => cli.command[0]))];

// Keeps pinned labels in place and adds a new one after the last label of its command.
function withLabel(pinned: readonly string[], label: string): string[] {
  if (pinned.includes(label)) return [...pinned];
  const group = label.split(" ")[0]!;
  const last = pinned.findLastIndex(key => key === group || key.startsWith(`${group} `));
  return last < 0 ? [...pinned, label] : pinned.toSpliced(last + 1, 0, label);
}

// operationAdmission.json keeps one row per line.
const inline = (value: Json): string => value !== null && typeof value === "object" && !Array.isArray(value)
  ? `{ ${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`).join(", ")} }`
  : JSON.stringify(value);
const admissionPath = here("./operationAdmission.json");
const admission = readJson<Record<string, Json>>(admissionPath);
for (const row of rows) admission[row.channel] = { guard: row.guard, scope: row.scope, handlerCheck: null };
writeFileSync(admissionPath, `{\n${Object.entries(admission).map(([channel, row]) => `  ${JSON.stringify(channel)}: ${inline(row)}`).join(",\n")}\n}\n`);

const ipcPath = here("./ipcExposure.main.json");
const ipc = readJson<{ names: string[]; guards: Record<string, string> }>(ipcPath);
for (const row of rows) {
  if (!ipc.names.includes(row.channel)) {
    ipc.names.push(row.channel);
    ipc.guards[row.channel] = row.guard;
  } else if (Object.hasOwn(ipc.guards, row.channel)) ipc.guards[row.channel] = row.guard;
}
writeJson(ipcPath, ipc);

const cliPath = here("./cliExposure.main.json");
const cli = readJson<{
  socketVerbs: string[]; publicSocketVerbs: string[]; publicVerbs: string[];
  help: Record<string, unknown> & { top: { prefix: string; commands: { group: string; block: string }[]; suffix: string } };
}>(cliPath);
const verbs = operations.map(({ cli: { verb } }) => verb);
cli.socketVerbs = [...new Set([...cli.socketVerbs, ...verbs])].sort();
cli.publicSocketVerbs = [...new Set([...cli.publicSocketVerbs, ...verbs])].sort();
cli.publicVerbs = labels.reduce(withLabel, cli.publicVerbs);
const top = renderCliHelp({ help: [] });
const { prefix, suffix } = cli.help.top;
if (!top.startsWith(prefix) || !top.endsWith(suffix)) throw new Error("dohc --help changed outside its commands. Edit cliExposure.main.json by hand.");
const blocks = top.slice(prefix.length, top.length - suffix.length).split(/(?=^ {2}\S)/mu);
const blockOf = Object.fromEntries(Object.keys(CLI_COMMANDS).map((group, index) => [group, blocks[index]]));
const commands = cli.help.top.commands.map(command => groups.includes(command.group) ? { ...command, block: blockOf[command.group]! } : command);
const help: Record<string, unknown> = { ...cli.help, top: { prefix, commands, suffix } };
for (const group of groups) help[group] = renderCliHelp({ help: [group] });
for (const { cli: { command } } of operations) help[command.join(" ")] = renderCliHelp({ help: command });
cli.help = Object.fromEntries([...groups, ...labels].reduce(withLabel, Object.keys(cli.help)).map(key => [key, help[key]])) as typeof cli.help;
writeJson(cliPath, cli);

const capabilitiesPath = here("./cliCapabilities.pinned.json");
const capabilities = readJson<{ socket: Record<string, readonly string[]>; public: Record<string, string> }>(capabilitiesPath);
for (const verb of verbs) capabilities.socket[verb] = CLI_CAPABILITIES[verb];
for (const label of labels) {
  const [group, name] = label.split(" ") as [string, string];
  capabilities.public[label] = CLI_COMMANDS[group]!.verbs[name]!.capabilityId;
}
writeJson(capabilitiesPath, capabilities);

// The dispatch fixture is source; add a line for each declared command it lacks.
const fixturePath = here("./cliDispatchInputs.fixture.ts");
const fixture = read(fixturePath);
const literal = (value: string) => value.includes('"') && !value.includes("'") ? `'${value}'` : JSON.stringify(value);
const missing = operations.filter(({ cli: { command } }) => !fixture.includes(`  ${JSON.stringify(command.join(" "))}: `))
  .map(({ cli: { command, example } }) => `  ${JSON.stringify(command.join(" "))}: [${example.map(literal).join(", ")}],\n`);
const jsonVerbs = "  // JSON verb parsers declare";
if (!fixture.includes(jsonVerbs)) throw new Error("cliDispatchInputs.fixture.ts changed shape. Add the declared commands by hand.");
writeFileSync(fixturePath, fixture.replace(jsonVerbs, missing.join("") + jsonVerbs));

const toolsPath = new URL("../../../../packages/mcp/src/toolsList.main.json", import.meta.url);
const tools = readJson<Record<string, Json[]>>(toolsPath);
const declaredTools = new Set<string>(operations.map(({ mcp }) => mcp.tool));
const nameOf = (tool: Json) => (tool as { name: string }).name;
for (const level of ["owner", "view", "comment", "edit"] as const) {
  const advertised = await advertisedCapabilityTools(level === "owner" ? undefined : level);
  const pinned = new Map(tools[level]!.map(tool => [nameOf(tool), tool]));
  for (const name of declaredTools) pinned.delete(name);
  for (const tool of advertised) {
    if (!declaredTools.has(tool.name)) continue;
    // The pin's key order is its own; keep an entry whose content is unchanged.
    const live = JSON.parse(JSON.stringify(tool)) as Json;
    const before = tools[level]!.find(entry => nameOf(entry) === tool.name);
    pinned.set(tool.name, before !== undefined && isDeepStrictEqual(before, live) ? before : live);
  }
  tools[level] = [...pinned.values()].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
}
writeJson(toolsPath, tools);
