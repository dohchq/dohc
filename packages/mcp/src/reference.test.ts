import { once } from "node:events";
import { MessageChannel as NodeMessageChannel, type MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachAppCollectionBroker } from "@dohc/app-browser/broker";
import { executeCli } from "@dohc/cli";
import { cliResultSchemas } from "@dohc/cli/protocol";
import { createDohcClient } from "@dohc/sdk";
import {
  APP_CHANNEL_REQUESTS,
  CLI_VERBS,
  MCP_RETURNS,
  REFERENCE_PATH,
  SDK_METHODS,
  mcpToolNames,
  renderReference,
} from "./reference";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CLI, MCP, and SDK reference", () => {
  // On a mismatch, regenerate the page with the command at its top.
  it(`matches ${REFERENCE_PATH}`, async () => {
    await expect(await renderReference()).toMatchFileSnapshot(`../../../${REFERENCE_PATH}`);
  });

  it("says what every registered MCP tool returns, and nothing more", async () => {
    expect(Object.keys(MCP_RETURNS).sort()).toEqual((await mcpToolNames()).sort());
  });

  it("places every CLI socket verb", () => {
    expect(Object.keys(CLI_VERBS).sort()).toEqual(Object.keys(cliResultSchemas).sort());
  });

  it("documents chat commands the CLI parses, with every documented flag", async () => {
    for (const [verb, entry] of Object.entries(CLI_VERBS)) {
      if (typeof entry === "string") continue;
      for (const argv of entry.examples) {
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
      for (const flag of Object.keys(entry.flags ?? {})) {
        expect(entry.usage, `${verb} usage`).toContain(flag);
        expect(entry.examples.flat(), `${verb} examples`).toContain(flag);
      }
    }
  });

  it("lists exactly the SDK client's methods", () => {
    const client = createDohcClient({ transport: { request: async () => undefined } });
    const methods: string[] = [];
    const walk = (value: object, prefix: string) => {
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "function") methods.push(`${prefix}${key}`);
        else if (child && typeof child === "object") walk(child, `${prefix}${key}.`);
      }
    };
    walk(client, "");
    expect(Object.keys(SDK_METHODS).sort()).toEqual(methods.sort());
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
