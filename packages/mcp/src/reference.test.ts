import { once } from "node:events";
import { MessageChannel as NodeMessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { executeCli } from "@dohc/cli";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { cliResultSchemas } from "@dohc/cli/protocol";
import {
  APP_CHANNEL_REQUESTS,
  APP_RESPONSE_RESULTS,
  APP_RESULTS,
  CHAT_EXAMPLES,
  DATASET_RESULTS,
  MCP_RETURNS,
  REFERENCE_PATH,
  mcpToolNames,
  renderReference,
} from "./reference";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CLI, MCP, and app channel reference", () => {
  // On a mismatch, regenerate the page with the command at its top.
  it(`matches ${REFERENCE_PATH}`, async () => {
    await expect(await renderReference()).toMatchFileSnapshot(`../../../${REFERENCE_PATH}`);
  });

  it("says what every registered MCP tool returns, and nothing more", async () => {
    expect(Object.keys(MCP_RETURNS).sort()).toEqual((await mcpToolNames()).sort());
  });

  it("gives every dataset and app verb in CLI_COMMANDS a result, and no other verb", () => {
    expect(Object.keys(DATASET_RESULTS).sort()).toEqual(Object.keys(CLI_COMMANDS.dataset!.verbs).sort());
    expect([...Object.keys(APP_RESULTS), ...Object.keys(APP_RESPONSE_RESULTS)].sort())
      .toEqual(Object.keys(CLI_COMMANDS.app!.verbs).sort());
  });

  it("documents every CLI socket verb, as a command or through an MCP tool", () => {
    const documented = new Set<string>([
      ...Object.keys(CLI_COMMANDS.chat!.verbs),
      "dataset", "appPublication", "ownerAppResponses", "fileWrite",
      ...Object.values(MCP_RETURNS).flatMap((returns) => typeof returns === "string" ? [] : [returns.cli]),
    ]);
    expect(Object.keys(cliResultSchemas).filter((verb) => !documented.has(verb))).toEqual([]);
  });

  it("parses an example of every chat verb, using every flag the verb declares", async () => {
    expect(Object.keys(CHAT_EXAMPLES).sort()).toEqual(Object.keys(CLI_COMMANDS.chat!.verbs).sort());
    for (const [verb, spec] of Object.entries(CLI_COMMANDS.chat!.verbs)) {
      const examples = CHAT_EXAMPLES[verb]!;
      for (const argv of examples) {
        let sent: unknown;
        const result = await executeCli({
          argv,
          cwd: "/workspace",
          env: {},
          request: async (request) => {
            sent = request;
            throw new Error("parsed");
          },
        });
        expect(sent, `${argv.join(" ")}: ${result.stderr}`).toMatchObject({ verb });
      }
      for (const flag of spec.flags ?? []) {
        expect(examples.flat(), `${verb} examples`).toContain(flag.name);
      }
    }
  });

  it("renders every CLI argument-source mapping alongside its notes", async () => {
    const page = await renderReference();
    for (const [commandName, command] of Object.entries(CLI_COMMANDS)) {
      for (const [verbName, verb] of Object.entries(command.verbs)) {
        const section = page.split(`#### \`dohc ${commandName} ${verbName}\``)[1]!.split("\n#### ")[0]!;
        for (const source of verb.take ?? []) {
          expect(section).toContain(`Set \`${source.field}\` to \`${source.path}\` from \`${source.from}\`.`);
        }
        for (const note of verb.notes ?? []) expect(section).toContain(note);
      }
    }
  });

  it("documents app channel requests that the broker forwards unchanged", async () => {
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    const forwarded: unknown[] = [];
    let port: NodeMessagePort | undefined;
    const frame = Object.assign(new EventTarget(), {
      contentWindow: {
        postMessage(message: unknown, _target: string, ports: NodeMessagePort[]) {
          expect(message).toEqual({ kind: "dohc-app-channel", version: 1 });
          port = ports[0];
        },
      },
    });
    const lifetime = new AbortController();
    attachAppCollectionBroker(frame as unknown as HTMLIFrameElement, async (body) => {
      forwarded.push(body);
      return Response.json({});
    }, lifetime.signal);
    frame.dispatchEvent(new Event("load"));
    try {
      for (const [index, { example }] of APP_CHANNEL_REQUESTS.entries()) {
        const body = { id: `request-${index}`, ...example };
        const reply = once(port!, "message");
        port!.postMessage(body);
        expect((await reply)[0], String(example.op)).toEqual({ id: body.id, ok: true, value: {} });
        expect(forwarded.at(-1)).toEqual(body);
      }
    } finally {
      lifetime.abort();
    }
  });
});
