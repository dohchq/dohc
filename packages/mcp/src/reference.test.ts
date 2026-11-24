import { once } from "node:events";
import {
  MessageChannel as NodeMessageChannel,
  type MessagePort as NodeMessagePort,
} from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { executeCli } from "@dohc/cli";
import { CLI_COMMANDS } from "@dohc/cli/args";
import { cliResultSchemas } from "@dohc/cli/protocol";
import {
  ACCESS_RESULTS,
  ACCOUNT_RESULTS,
  APP_CHANNEL_REQUESTS,
  APP_RESPONSE_RESULTS,
  APP_RESULTS,
  CHAT_EXAMPLES,
  CHAT_SOCKET_VERBS,
  DATASET_RESULTS,
  HISTORY_RESULTS,
  MCP_RETURNS,
  MCP_TOOL_GROUPS,
  REFERENCE_PATH,
  mcpToolNames,
  renderReference,
} from "./reference";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CLI, MCP, and app channel reference", () => {
  it(`matches ${REFERENCE_PATH}`, async () => {
    await expect(await renderReference()).toMatchFileSnapshot(`../../../${REFERENCE_PATH}`);
  });

  it("says what every registered MCP tool returns, and nothing more", async () => {
    const contexts = [undefined, "view", "comment", "edit"] as const;
    const registered = await Promise.all(contexts.map((context) => mcpToolNames(context)));
    const allRegistered = [...new Set(registered.flat())].sort();
    expect(Object.keys(MCP_RETURNS).sort()).toEqual(allRegistered);
    expect(MCP_TOOL_GROUPS.flatMap((group) => group.tools).sort()).toEqual(allRegistered);
    const page = await renderReference();
    for (const name of registered.flat()) expect(page).toContain(`### \`${name}\``);
    expect(page).toContain("**Core everyday building**");
    expect(page).toContain("**Internal sync, live-document, and recovery**");
  });

  it("documents tools available only in editable shares", async () => {
    const page = await renderReference();
    const section = page.split("### `dohc_switch_automation`")[1]!.split(/\n#{2,3} /)[0]!;
    expect(section).toContain("Available only in a shared workspace with edit access.");
    expect(section).toContain("`expectedContentHash`");
    expect(section).toContain("Returns ");
  });

  it("gives every dataset and app verb in CLI_COMMANDS a result, and no other verb", () => {
    expect(Object.keys(DATASET_RESULTS).sort()).toEqual(
      Object.keys(CLI_COMMANDS.dataset!.verbs).sort(),
    );
    expect([...Object.keys(APP_RESULTS), ...Object.keys(APP_RESPONSE_RESULTS)].sort()).toEqual(
      Object.keys(CLI_COMMANDS.app!.verbs).sort(),
    );
  });

  it("documents every CLI socket verb, as a command or through an MCP tool", () => {
    const documented = new Set<string>([
      ...Object.keys(CLI_COMMANDS.chat!.verbs),
      ...Object.values(CHAT_SOCKET_VERBS),
      ...Object.values(ACCESS_RESULTS),
      ...Object.values(ACCOUNT_RESULTS),
      ...Object.values(HISTORY_RESULTS),
      "dataset",
      "appPublication",
      "ownerAppResponses",
      "fileWrite",
      "fileMove",
      "fileDelete",
      // dohc_workspace_status reports it as its `collectionsWaiting` field.
      "collectionsWaiting",
      // dohc document kept-edits prints it; dohc_workspace_status reports it as `keptEdits`.
      "liveKeptEdits",
      // dohc_workspace_status reports it as its `heldFiles` field.
      "sharedFilesHeld",
      // dohc_workspace_status reports it as its `syncFailure` field.
      "syncFailure",
      // dohc_reply_to_chat sends it for `nothingToReport`.
      "nothingToReport",
      ...Object.values(MCP_RETURNS).flatMap((returns) =>
        typeof returns === "string" ? [] : [returns.cli],
      ),
    ]);
    expect(Object.keys(cliResultSchemas).filter((verb) => !documented.has(verb))).toEqual([]);
  });

  it("documents Access commands with their socket results and observation limits", async () => {
    expect(Object.keys(ACCESS_RESULTS).sort()).toEqual(
      Object.keys(CLI_COMMANDS.access!.verbs).sort(),
    );
    const page = await renderReference();
    const section = page.split("### `dohc access`")[1]!.split("\n### ")[0]!;
    for (const [name, socketVerb] of Object.entries(ACCESS_RESULTS)) {
      expect(section).toContain(`#### \`dohc access ${name}\``);
      expect(section).toContain(`Uses socket verb \`${socketVerb}\`.`);
    }
    expect(section).toContain("only the allowlisted AccessAnswer fields");
    expect(section).toContain(
      "never return credentials, bearer URLs, invitation URLs, share codes, or link URLs",
    );
    expect(section).toContain("Use `dohc access refresh` to request fresh Sharing inventories");
    expect(section).toContain(
      "Requested and joined wait for started or existing attempts to settle",
    );
    expect(section).toContain("`joined`, `paced`, or `unavailable`");
    expect(section).toContain("`freshness` is `fresh`, `stale`, or `unknown`");
    expect(section).toContain("`checkedAtMs`");
    expect(section).toContain("`coverage`");
    expect(section).toContain("`unknownReason`");
    expect(section).toContain("When visibility is `hidden` or `missing`, it is null");
    for (const reason of [
      "signed-out",
      "not-synced",
      "other-account",
      "other-server",
      "not-listed-yet",
      "changed",
      "unreadable",
    ]) {
      expect(section).toContain(reason);
    }
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
        expect(sent, `${argv.join(" ")}: ${result.stderr}`).toMatchObject({
          verb: CHAT_SOCKET_VERBS[verb] ?? verb,
        });
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
        const section = page
          .split(`#### \`dohc ${commandName} ${verbName}\``)[1]!
          .split("\n#### ")[0]!;
        for (const source of verb.take ?? []) {
          expect(section).toContain(
            `Set \`${source.field}\` to \`${source.path}\` from \`${source.from}\`.`,
          );
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
    const fileMeta = {
      fileId: "file_0123456789abcdef",
      name: "receipt.pdf",
      contentType: "application/pdf",
      byteLength: 4,
      sha256: "a".repeat(64),
    };
    const lifetime = new AbortController();
    attachAppCollectionBroker(
      frame as unknown as HTMLIFrameElement,
      async (body) => {
        forwarded.push(body);
        if ((body as { op?: string }).op === "backend.file") {
          return new Response(new Uint8Array([37, 80, 68, 70]), {
            status: 200,
            headers: {
              "content-type": "application/octet-stream",
              "x-dohc-app-file": encodeURIComponent(JSON.stringify(fileMeta)),
            },
          });
        }
        return Response.json({});
      },
      lifetime.signal,
    );
    frame.dispatchEvent(new Event("load"));
    try {
      for (const [index, { example }] of APP_CHANNEL_REQUESTS.entries()) {
        const bytes = example.bytes instanceof ArrayBuffer ? example.bytes.slice(0) : undefined;
        const body = { id: `request-${index}`, ...example, ...(bytes ? { bytes } : {}) };
        const reply = once(port!, "message");
        port!.postMessage(body, bytes ? [bytes] : []);
        const received = (await reply)[0] as { id: string; ok: boolean; value?: unknown };
        if (example.op === "backend.file") {
          expect(received.id).toBe(body.id);
          expect(received.ok).toBe(true);
          const value = received.value as { file: unknown; bytes: ArrayBuffer };
          expect(value.file).toEqual(fileMeta);
          expect(Array.from(new Uint8Array(value.bytes))).toEqual([37, 80, 68, 70]);
        } else {
          expect(received, String(example.op)).toEqual({ id: body.id, ok: true, value: {} });
        }
        if (example.op === "backend.upload") {
          expect(forwarded.at(-1)).toMatchObject({
            id: body.id,
            op: "backend.upload",
            name: example.name,
            contentType: example.contentType,
            idempotencyKey: example.idempotencyKey,
          });
          expect(
            Array.from(new Uint8Array((forwarded.at(-1) as { bytes: ArrayBuffer }).bytes)),
          ).toEqual([37, 80, 68, 70]);
        } else {
          expect(forwarded.at(-1)).toEqual(body);
        }
      }
    } finally {
      lifetime.abort();
    }
  });
});
