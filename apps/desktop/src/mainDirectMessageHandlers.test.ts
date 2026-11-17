import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DirectMemberPick, DirectSendResult } from "@dohc/security-contract/direct-messages";
import { createDirectMessages } from "./workspaces/directMessages";
import { refuseChatFileLinks } from "./workspaces/chatFileLinkScope";

const viewerId = "ann";
const workspace = { workspaceId: "local-workspace" };
const person: DirectMemberPick = { workspaceId: "relay-workspace", memberId: "bob" };
type Message = { viewerId: string; messageId: string; body: string };
type Handlers = {
  directStart(
    input: Message & { memberId: string },
    context: { operation: { workspace: typeof workspace } },
  ): Promise<DirectSendResult>;
  directSend(input: Message & { conversationId: string }): Promise<DirectSendResult>;
};

function harness() {
  const sent: unknown[] = [];
  const directMessages = createDirectMessages({
    credentials: async () => ({ userId: viewerId, relayUrl: "https://relay.test" }),
    relayResponse: async (_credentials, _path, init) => {
      sent.push(JSON.parse(String(init.body)));
      return Response.json({ conversationId: "c1", seq: sent.length });
    },
    changed: () => undefined,
    listedChanged: () => undefined,
  });
  // Run main's handlers without starting Electron.
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const start = source.indexOf("    directStart:");
  const end = source.indexOf("    directMarkRead:", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const handlers = new Function(
    "directMessages",
    "directPick",
    "refuseChatFileLinks",
    `return ({${source.slice(start, end)}});`,
  )(directMessages, async () => person, refuseChatFileLinks) as Handlers;
  return { handlers, sent };
}

describe("account direct-message send handlers", () => {
  it.each(["directStart", "directSend"] as const)(
    "%s refuses file links before sending, and still sends plain text",
    async (action) => {
      const h = harness();
      const send = (body: string) => {
        const message = { viewerId, messageId: "m1", body };
        return Promise.resolve().then(() =>
          action === "directStart"
            ? h.handlers.directStart({ ...message, memberId: "bob" }, { operation: { workspace } })
            : h.handlers.directSend({ ...message, conversationId: "c1" }),
        );
      };
      await expect(send("Read @[notes/private.md]")).rejects.toThrow(
        "Files can't be linked in a direct message.",
      );
      expect(h.sent).toEqual([]);
      await expect(send("Hello Bob")).resolves.toEqual({ conversationId: "c1", seq: 1 });
      expect(h.sent).toEqual([expect.objectContaining({ messageId: "m1", body: "Hello Bob" })]);
    },
  );
});
