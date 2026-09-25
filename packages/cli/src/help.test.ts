import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OwnerAppPublicationResult } from "./appPublication";
import { CLI_COMMANDS } from "./args";
import { DatasetResult } from "./dataset";
import { executeCli } from "./index";

async function help(...argv: string[]): Promise<string> {
  const send = vi.fn();
  const result = await executeCli({ argv, env: {}, request: send });
  expect(send).not.toHaveBeenCalled();
  expect(result).toMatchObject({ exitCode: 0, stderr: "" });
  return result.stdout;
}

const flat = (text: string) => text.replace(/\s+/g, " ");

/** Whether a path such as entries[].schema.revisionHash names a field of the schema. */
function hasPath(schema: z.ZodType, path: readonly string[]): boolean {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) return hasPath(schema.unwrap() as z.ZodType, path);
  if (schema instanceof z.ZodUnion) return schema.options.some((option) => hasPath(option as z.ZodType, path));
  const [step, ...rest] = path;
  if (step === undefined) return true;
  if (step === "[]") return schema instanceof z.ZodArray && hasPath(schema.element as z.ZodType, rest);
  return schema instanceof z.ZodObject && Object.hasOwn(schema.shape, step) && hasPath(schema.shape[step] as z.ZodType, rest);
}

function resultOf(schema: z.ZodDiscriminatedUnion, kind: string): z.ZodType {
  const option = schema.options.find((candidate) => candidate instanceof z.ZodObject && candidate.shape.kind?.value === kind);
  if (!option) throw new Error(`no result kind ${kind}`);
  return option as z.ZodType;
}

const RESULTS: Record<string, Record<string, z.ZodType>> = {
  dataset: {
    history: resultOf(DatasetResult, "history"),
    permissions: resultOf(DatasetResult, "permissions"),
    deletePreview: resultOf(DatasetResult, "delete-preview"),
    pendingAttempts: resultOf(DatasetResult, "pending-attempts"),
    prepareRecovery: resultOf(DatasetResult, "recovery-prepared"),
  },
  app: { list: resultOf(OwnerAppPublicationResult, "listed") },
};

describe("CLI help", () => {
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

  it("names real fields when a request copies an earlier result", async () => {
    let sources = 0;
    for (const [commandName, command] of Object.entries(CLI_COMMANDS)) {
      for (const [verbName, verb] of Object.entries(command.verbs)) {
        for (const source of verb.take ?? []) {
          const label = `${commandName} ${verbName} ${source.field}`;
          expect(Object.keys(verb.fields ?? {}), label).toContain(source.field);
          const result = RESULTS[commandName]?.[source.from];
          expect(result, label).toBeDefined();
          expect(hasPath(result!, source.path.replace(/\[\]/g, ".[]").split(".")), label).toBe(true);
          sources += 1;
        }
      }
    }
    expect(sources).toBeGreaterThan(0);
    expect(flat(await help("dataset", "delete", "--help"))).toContain("Set expected to cursor from deletePreview.");
  });

  it("answers bare commands with help and keeps lines readable", async () => {
    expect(await help()).toBe(await help("--help"));
    expect(await help("chat")).toBe(await help("chat", "-h"));
    expect(await help("chat", "--help", "post")).toBe(await help("chat", "post", "--help"));
    for (const argv of [["--help"], ["dataset", "--help"], ["chat", "grep", "--help"]]) {
      for (const line of (await help(...argv)).split("\n")) expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it("tells people where workspaceId and agent identity come from", async () => {
    expect(flat(await help("dataset", "list", "--help"))).toContain("Find workspaceId in .dohc/manifest.json");
    expect(flat(await help("app", "--help"))).toContain("Find workspaceId in .dohc/manifest.json");
    expect(await help("chat", "--help")).toContain("DOHC_CHAT_ACTOR=agent");
    expect(await help("chat", "reply", "--help")).toMatch(/^ {2}--resolve <message> +Resolve this open decision/m);
    const dashRule = "Put options first, then --, then text that starts with a dash.";
    for (const verb of ["post", "reply", "grep"]) expect(flat(await help("chat", verb, "--help"))).toContain(dashRule);
    for (const verb of ["show", "export"]) expect(flat(await help("chat", verb, "--help"))).not.toContain(dashRule);
    expect(flat(await help("dataset", "list", "--help"))).not.toContain(dashRule);
  });

  it("refuses with exit 1 instead of showing help once a verb has input", async () => {
    for (const [argv, stderr] of [
      [["site"], "dohc: unknown command 'site'; run dohc --help\n"],
      [["chat", "channels"], "dohc: unknown chat verb 'channels'; run dohc chat --help\n"],
      [["chat", "constructor"], "dohc: unknown chat verb 'constructor'; run dohc chat --help\n"],
      [["dataset", "list"], "dohc: dataset list requires one JSON object; run dohc dataset list --help\n"],
      [
        ["chat", "post", "general", "--help", "me"],
        "dohc: unknown chat post option '--help'; put options first, then --, then text that starts with a dash\n",
      ],
    ] as const) {
      const send = vi.fn();
      expect(await executeCli({ argv, env: {}, request: send })).toEqual({ exitCode: 1, stdout: "", stderr });
      expect(send).not.toHaveBeenCalled();
    }
  });
});
