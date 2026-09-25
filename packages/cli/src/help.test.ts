import { describe, expect, it, vi } from "vitest";
import { OwnerAppPublicationRequest } from "./appPublication";
import { OwnerAppResponsesRequest } from "./appResponses";
import { CLI_COMMANDS } from "./args";
import { DatasetRequest } from "./dataset";
import { executeCli } from "./index";

async function help(...argv: string[]): Promise<string> {
  const send = vi.fn();
  const result = await executeCli({ argv, env: {}, request: send });
  expect(send).not.toHaveBeenCalled();
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

const flat = (text: string) => text.replace(/\s+/g, " ");

describe("CLI help", () => {
  it("dispatches every request action the CLI can send", () => {
    const actions = (options: readonly { shape: { action: { value: string } } }[]) =>
      options.map((option) => option.shape.action.value).sort();
    expect(Object.keys(CLI_COMMANDS.dataset.verbs).sort()).toEqual(actions(DatasetRequest.options));
    expect(Object.keys(CLI_COMMANDS.app.verbs).sort()).toEqual(
      [...actions(OwnerAppPublicationRequest.options), "responses", "undo-responses"].sort(),
    );
    expect(OwnerAppResponsesRequest.options.map((option) => option.shape.action.value)).toEqual(["list", "undo"]);
  });

  it("gives every dispatched verb a line in help and its own flags", async () => {
    const top = await help("--help");
    for (const [commandName, command] of Object.entries(CLI_COMMANDS)) {
      expect(flat(top)).toContain(`${commandName} ${command.summary}`);
      const commandText = await help(commandName, "--help");
      for (const [verbName, verb] of Object.entries(command.verbs)) {
        expect(verb.summary, `${commandName} ${verbName}`).toMatch(/\S/);
        expect(top).toMatch(new RegExp(`[ ,]${verbName}(,|\\n)`));
        expect(flat(commandText)).toContain(` ${verbName} ${verb.summary}`);
        const verbText = await help(commandName, verbName, "--help");
        expect(verbText).toContain(`Usage: dohc ${commandName} ${verbName} `);
        for (const flag of [...(verb.flags ?? []), { name: "--as-agent" }, { name: "--json" }]) {
          expect(verbText).toMatch(new RegExp(`^  ${flag.name} `, "m"));
        }
        for (const field of Object.keys(verb.fields ?? {}).filter((name) => name !== "action")) {
          expect(flat(verbText)).toMatch(new RegExp(`(Fields|Optional fields): (\\w+, )*${field}\\b`));
        }
      }
    }
  });

  it("answers bare commands with help and keeps lines readable", async () => {
    expect(await help()).toBe(await help("--help"));
    expect(await help("chat")).toBe(await help("chat", "-h"));
    expect(await help("chat", "post", "general", "--help")).toBe(await help("chat", "post", "--help"));
    for (const argv of [["--help"], ["dataset", "--help"], ["chat", "grep", "--help"]]) {
      for (const line of (await help(...argv)).split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it("tells people where workspaceId and agent identity come from", async () => {
    expect(flat(await help("dataset", "list", "--help"))).toContain("Find workspaceId in .dohc/manifest.json");
    expect(flat(await help("app", "--help"))).toContain("Find workspaceId in .dohc/manifest.json");
    expect(await help("chat", "--help")).toContain("DOHC_CHAT_ACTOR=agent");
    expect(await help("chat", "reply", "--help")).toMatch(/^ {2}--resolve <message> +Resolve this open decision/m);
  });

  it("points unknown commands and verbs at help", async () => {
    for (const [argv, stderr] of [
      [["site"], "dohc: unknown command 'site'; run dohc --help\n"],
      [["chat", "channels"], "dohc: unknown chat verb 'channels'; run dohc chat --help\n"],
      [["chat", "constructor"], "dohc: unknown chat verb 'constructor'; run dohc chat --help\n"],
      [["dataset", "list"], "dohc: dataset list requires one JSON object; run dohc dataset list --help\n"],
    ] as const) {
      expect(await executeCli({ argv, env: {}, request: vi.fn() })).toEqual({ exitCode: 1, stdout: "", stderr });
    }
  });
});
