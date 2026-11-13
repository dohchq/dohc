// The five link reads at the MCP door. linkReadTools.expected.txt records what
// an MCP client sees, so moving a read to another definition cannot change a
// byte of it. Nothing here imports where a read is declared, so its refusals
// cannot pass by construction. apps/desktop/src/cli/linkReadDoors.test.ts
// records the desktop doors.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DohcCliError } from "@dohc/cli/errors";
import { expect, it } from "vitest";
import { createDohcMcpServer } from "./server";
import type { ToolContext } from "./tools";

const TOOLS = ["dohc_links_edges", "dohc_links_in", "dohc_links_resolve", "dohc_chat_links", "dohc_chat_file_mentions"];
const LEVELS = [undefined, "view", "comment", "edit"] as const;

const EDGES_PAGE = {
  versionId: "v1", files: [{ objectId: "obj-a", path: "a.md", title: "A" }],
  entries: [{ source: "a.md", target: "b.md", kind: "wikilink", ordinal: 0 }],
  unchecked: ["c.md"], complete: false, indexBuilding: true, mountsCovered: true, nextCursor: "edges-2",
};
const EDGES_EMPTY = { ...EDGES_PAGE, files: [], entries: [], unchecked: [], complete: true, indexBuilding: false, nextCursor: null };
const IN_PAGE = {
  versionId: "v1", subject: { path: "b.md", objectId: "obj-b" },
  entries: [{ source: "a.md", title: "A", ordinal: 0, span: [4, 9], line: 1, highlightStart: 4, highlightEnd: 9, snippet: "See [[b]]." }],
  unchecked: ["c.md"], complete: false, indexBuilding: false, mountsCovered: false, nextCursor: "in-2",
};
const IN_EMPTY = { ...IN_PAGE, entries: [], unchecked: [], complete: true, mountsCovered: true, nextCursor: null };
const RESOLVED = {
  versionId: "v1", mountsCovered: true,
  results: [{ path: "b.md", fragment: null }, { path: null, create: "new.md", fragment: "top" }, null],
};
const RESOLVED_EMPTY = { versionId: "v1", mountsCovered: true, results: [] };
const CHAT_LINKS_PAGE = {
  versionId: "v1", subject: { channelWireId: "wire-general" },
  entries: [{
    threadId: "th-1", messageId: "m-1", mentionedAtMs: 1000,
    file: { objectId: "obj-a", path: "a.md", folder: "" },
    author: { kind: "human", displayName: "Sam", presentation: { group: "you", hue: null, self: true } },
  }],
  unchecked: [], complete: false, indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 1, nextCursor: "links-2",
};
const CHAT_LINKS_EMPTY = { ...CHAT_LINKS_PAGE, entries: [], complete: true, sharedChannelRowsUncovered: 0, nextCursor: null };
const MENTIONS_PAGE = {
  versionId: "v1", subject: { objectId: "obj-a", path: "a.md" },
  entries: [{
    attachment: { attachmentId: "att-1", threadId: "th-1", messageId: "m-1", targetKind: "file", objectId: "obj-a", pathHint: "a.md", createdAtMs: 1000 },
    message: { id: "m-1", authorDisplayName: "Sam", preview: "See a.md", createdAtMs: 1000 },
    thread: { id: "th-1", title: "Plan", createdAtMs: 900, updatedAtMs: 1000 },
    channelWireId: "wire-general", channelName: "General", channelSlug: "general", channelKind: "channel",
  }],
  unchecked: [], complete: false, indexBuilding: false, mountsCovered: true, sharedChannelRowsUncovered: 2, nextCursor: "mentions-2",
};
const MENTIONS_EMPTY = { ...MENTIONS_PAGE, subject: null, entries: [], complete: true, sharedChannelRowsUncovered: 0, nextCursor: null };
const NOT_A_PAGE = { versionId: "v1" };

// A member's Group whose share covers only team/. The relay has already
// withheld its link to a file outside team/ before the message reached this
// computer (#3900), so the reads answer only covered files, and a preview
// holds the words that stand in for the withheld link.
const WITHHELD = "(a file not shared here)";
const SHARED_LINKS_PAGE = {
  ...CHAT_LINKS_PAGE, subject: { channelWireId: "wire-team" }, sharedChannelRowsUncovered: 0, nextCursor: null,
  entries: [{ ...CHAT_LINKS_PAGE.entries[0]!, file: { objectId: "obj-t", path: "team/plan.md", folder: "team" } }],
};
const WITHHELD_MENTIONS_PAGE = {
  ...MENTIONS_PAGE, subject: { objectId: "obj-t", path: "team/plan.md" }, sharedChannelRowsUncovered: 0, nextCursor: null,
  entries: [{
    ...MENTIONS_PAGE.entries[0]!,
    attachment: { ...MENTIONS_PAGE.entries[0]!.attachment, objectId: "obj-t", pathHint: "team/plan.md" },
    message: { ...MENTIONS_PAGE.entries[0]!.message, preview: `See team/plan.md and ${WITHHELD}` },
    channelWireId: "wire-team", channelName: "Team", channelSlug: "team",
  }],
};
const STALE = "dohc: This cursor belongs to another index. Start again without it.";
const LONG = "x".repeat(32_769);

type Answer = () => unknown;
const page = (value: unknown): Answer => () => value;
const refused = (message: string): Answer => () => { throw new DohcCliError(message); };

async function withClient<T>(ctx: ToolContext, use: (client: Client) => Promise<T>): Promise<T> {
  const server = createDohcMcpServer(ctx);
  const client = new Client({ name: "link-read-tools", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const ROOT = "/link-read-workspace";

async function call(name: string, args: Record<string, unknown>, reply: Answer = page(null), extra: Partial<ToolContext> = {}) {
  const sent: string[] = [];
  const ctx: ToolContext = {
    root: ROOT, home: "/link-read-home", ...extra,
    request: async request => { sent.push(JSON.stringify(request)); return reply(); },
  };
  const outcome = await withClient(ctx, async client => {
    try {
      return { result: await client.callTool({ name, arguments: args }) };
    } catch (error) {
      return { thrown: error instanceof Error ? error.message : String(error) };
    }
  });
  const context = Object.fromEntries(Object.entries(extra).map(([key, value]) => [key, value instanceof Set ? [...value] : value]));
  return { name, args, ...(Object.keys(context).length ? { context } : {}), ...outcome, sent };
}

// A long cursor records as its length, so the recording stays readable.
const longCursor = (entry: Awaited<ReturnType<typeof call>>) => ({ ...entry, args: { ...entry.args, cursor: `<${LONG.length} characters>` } });

async function listed() {
  const levels: unknown[] = [];
  for (const shareAccess of LEVELS) {
    const tools = await withClient({ root: ROOT, home: "/link-read-home", shareAccess }, async client => (await client.listTools()).tools);
    const names = tools.map(tool => tool.name);
    levels.push({
      level: shareAccess ?? "owner",
      // Where each read sits among all the level's tools, in the order the server lists them.
      positions: Object.fromEntries(TOOLS.map(name => [name, names.indexOf(name)])),
      before: TOOLS.map(name => names[names.indexOf(name) - 1] ?? null),
      tools: tools.filter(tool => TOOLS.includes(tool.name)),
    });
  }
  return levels;
}

async function refusals(name: string, args: Record<string, unknown>, reply: Answer) {
  return [
    await call(name, args, refused("dohc: not inside a dohc workspace")),
    await call(name, args, refused("dohc: CLI authentication failed")),
    await call(name, args, refused("desktop app not running")),
    await call(name, args, page(NOT_A_PAGE)),
    await call(name, args, reply, { agentId: "nova" }),
    await call(name, args, reply, { tools: new Set(["dohc_read_chat"] as const) }),
    await call(name, args, reply, { shareAccess: "view" }),
    await call(name, { ...args, extra: true }, reply),
  ];
}

// One line per case under a heading per read, so a changed case names itself in a diff.
function recorded(sections: Record<string, unknown[]>): string {
  return Object.entries(sections).flatMap(([section, cases]) => [
    `## ${section}`,
    ...cases.map(entry => JSON.stringify(entry)),
  ]).join("\n") + "\n";
}

it("keeps the MCP door of the five link reads as recorded", async () => {
  const sections = {
    "tools/list": await listed(),
    dohc_links_edges: [
      await call("dohc_links_edges", {}, page(EDGES_PAGE)),
      await call("dohc_links_edges", { cursor: "edges-2" }, page(EDGES_EMPTY)),
      await call("dohc_links_edges", { cursor: "stale" }, refused(STALE)),
      await call("dohc_links_edges", { cursor: 5 }, page(EDGES_PAGE)),
      await call("dohc_links_edges", { cursor: "x".repeat(32_769) }, page(EDGES_PAGE)).then(entry => ({ ...entry, args: { cursor: "<32769 characters>" } })),
      ...await refusals("dohc_links_edges", {}, page(EDGES_PAGE)),
      await call("dohc_links_edges", { cursor: 5, extra: true }, page(EDGES_PAGE)),
    ],
    dohc_links_in: [
      await call("dohc_links_in", { subject: { path: "b.md" } }, page(IN_PAGE)),
      await call("dohc_links_in", { subject: { objectId: "obj-b" }, cursor: "in-2" }, page(IN_EMPTY)),
      await call("dohc_links_in", { subject: { path: "gone.md" } }, page(null)),
      await call("dohc_links_in", { subject: { path: "b.md" }, cursor: "stale" }, refused(STALE)),
      await call("dohc_links_in", {}, page(IN_PAGE)),
      await call("dohc_links_in", { subject: { path: "b.md", objectId: "obj-b" } }, page(IN_PAGE)),
      ...await refusals("dohc_links_in", { subject: { path: "b.md" } }, page(IN_PAGE)),
      await call("dohc_links_in", { subject: { path: "" }, cursor: LONG }, page(IN_PAGE)).then(longCursor),
    ],
    dohc_links_resolve: [
      await call("dohc_links_resolve", { source: "a.md", literals: [{ kind: "wikilink", literal: "b" }, { kind: "markdown", literal: "new.md#top" }, { kind: "wikilink", literal: "" }] }, page(RESOLVED)),
      await call("dohc_links_resolve", { source: "a.md", literals: [] }, page(RESOLVED_EMPTY)),
      await call("dohc_links_resolve", { source: "a.md", literals: [] }, page(null)),
      await call("dohc_links_resolve", { source: "a.md" }, page(RESOLVED)),
      await call("dohc_links_resolve", { source: "a.md", literals: [{ kind: "other", literal: "b" }] }, page(RESOLVED)),
      ...await refusals("dohc_links_resolve", { source: "a.md", literals: [] }, page(RESOLVED)),
      await call("dohc_links_resolve", { source: 5, literals: "x" }, page(RESOLVED)),
    ],
    dohc_chat_links: [
      await call("dohc_chat_links", { channelWireId: "wire-general" }, page(CHAT_LINKS_PAGE)),
      await call("dohc_chat_links", { channelWireId: "wire-general", cursor: "links-2" }, page(CHAT_LINKS_EMPTY)),
      await call("dohc_chat_links", { channelWireId: "wire-hidden" }, page(null)),
      await call("dohc_chat_links", { channelWireId: "wire-general", cursor: "stale" }, refused("dohc: chat-mention-access-changed")),
      await call("dohc_chat_links", { group: "general" }, page(CHAT_LINKS_PAGE)),
      await call("dohc_chat_links", {}, page(CHAT_LINKS_PAGE)),
      await call("dohc_chat_links", { channelWireId: "" }, page(CHAT_LINKS_PAGE)),
      ...await refusals("dohc_chat_links", { channelWireId: "wire-general" }, page(CHAT_LINKS_PAGE)),
      await call("dohc_chat_links", { channelWireId: "", cursor: LONG }, page(CHAT_LINKS_PAGE)).then(longCursor),
      await call("dohc_chat_links", { channelWireId: "wire-team" }, page(SHARED_LINKS_PAGE)),
    ],
    dohc_chat_file_mentions: [
      await call("dohc_chat_file_mentions", {}, page(MENTIONS_PAGE)),
      await call("dohc_chat_file_mentions", { subject: { path: "a.md" }, cursor: "mentions-2" }, page(MENTIONS_EMPTY)),
      await call("dohc_chat_file_mentions", { subject: { objectId: "obj-a" } }, page(null)),
      await call("dohc_chat_file_mentions", { cursor: "stale" }, refused("dohc: chat-mention-access-changed")),
      await call("dohc_chat_file_mentions", { subject: { path: "a.md", objectId: "obj-a" } }, page(MENTIONS_PAGE)),
      await call("dohc_chat_file_mentions", { subject: "a.md" }, page(MENTIONS_PAGE)),
      ...await refusals("dohc_chat_file_mentions", {}, page(MENTIONS_PAGE)),
      await call("dohc_chat_file_mentions", { subject: "a.md", cursor: LONG }, page(MENTIONS_PAGE)).then(longCursor),
      await call("dohc_chat_file_mentions", { subject: { path: "team/plan.md" } }, page(WITHHELD_MENTIONS_PAGE)),
    ],
  };
  await expect(recorded(sections)).toMatchFileSnapshot("./linkReadTools.expected.txt");
});
