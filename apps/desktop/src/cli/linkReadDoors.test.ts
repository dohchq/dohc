// The five link reads at each desktop door: the IPC row, the CLI socket, and
// the public command line. linkReadDoors.expected.txt records what a caller
// sees, so moving a read to another definition cannot change a byte of it.
// Nothing here imports where a read is declared, so its refusals cannot pass
// by construction. packages/mcp/src/linkReadTools.test.ts records the MCP door.
import { executeCli } from "@dohc/cli";
import { DohcCliError } from "@dohc/cli/errors";
import { CLI_PROTOCOL_VERSION } from "@dohc/cli/protocol";
import type { ChatChannelSummary } from "@dohc/workspace-contracts/engine";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { chatOperations } from "../ipc/chatOperations";
import { linksOperations } from "../ipc/linksOperations";
import {
  registerOperations,
  type OperationBoundary,
  type OperationHandlers,
} from "../ipc/operationTable";
import { createTestScratch, removeTestScratch } from "../workspaces/testTemp";
import {
  handleCliRequestLine,
  type CliRegistryWorkspace,
  type CliServerOptions,
  type CliWorkspaceContext,
} from "./cliServer";

const EDGES_PAGE = {
  versionId: "v1",
  files: [{ objectId: "obj-a", path: "a.md", title: "A" }],
  entries: [{ source: "a.md", target: "b.md", kind: "wikilink", ordinal: 0 }],
  unchecked: ["c.md"],
  complete: false,
  indexBuilding: true,
  mountsCovered: true,
  nextCursor: "edges-2",
};
const EDGES_EMPTY = {
  ...EDGES_PAGE,
  files: [],
  entries: [],
  unchecked: [],
  complete: true,
  indexBuilding: false,
  nextCursor: null,
};
const IN_PAGE = {
  versionId: "v1",
  subject: { path: "b.md", objectId: "obj-b" },
  entries: [
    {
      source: "a.md",
      title: "A",
      ordinal: 0,
      span: [4, 9],
      line: 1,
      highlightStart: 4,
      highlightEnd: 9,
      snippet: "See [[b]].",
    },
  ],
  unchecked: ["c.md"],
  complete: false,
  indexBuilding: false,
  mountsCovered: false,
  nextCursor: "in-2",
};
const IN_EMPTY = {
  ...IN_PAGE,
  entries: [],
  unchecked: [],
  complete: true,
  mountsCovered: true,
  nextCursor: null,
};
const RESOLVED = {
  versionId: "v1",
  mountsCovered: true,
  results: [
    { path: "b.md", fragment: null },
    { path: null, create: "new.md", fragment: "top" },
    null,
  ],
};
const RESOLVED_EMPTY = { versionId: "v1", mountsCovered: true, results: [] };
const CHAT_LINKS_PAGE = {
  versionId: "v1",
  subject: { channelWireId: "wire-general" },
  entries: [
    {
      threadId: "th-1",
      messageId: "m-1",
      mentionedAtMs: 1000,
      file: { objectId: "obj-a", path: "a.md", folder: "" },
      author: {
        kind: "human",
        displayName: "Sam",
        presentation: { group: "you", hue: null, self: true },
      },
    },
  ],
  unchecked: [],
  complete: false,
  indexBuilding: false,
  mountsCovered: true,
  sharedChannelRowsUncovered: 1,
  nextCursor: "links-2",
};
const CHAT_LINKS_EMPTY = {
  ...CHAT_LINKS_PAGE,
  entries: [],
  complete: true,
  sharedChannelRowsUncovered: 0,
  nextCursor: null,
};
const MENTIONS_PAGE = {
  versionId: "v1",
  subject: { objectId: "obj-a", path: "a.md" },
  entries: [
    {
      attachment: {
        attachmentId: "att-1",
        threadId: "th-1",
        messageId: "m-1",
        targetKind: "file",
        objectId: "obj-a",
        pathHint: "a.md",
        createdAtMs: 1000,
      },
      message: { id: "m-1", authorDisplayName: "Sam", preview: "See a.md", createdAtMs: 1000 },
      thread: { id: "th-1", title: "Plan", createdAtMs: 900, updatedAtMs: 1000 },
      channelWireId: "wire-general",
      channelName: "General",
      channelSlug: "general",
      channelKind: "channel",
    },
  ],
  unchecked: [],
  complete: false,
  indexBuilding: false,
  mountsCovered: true,
  sharedChannelRowsUncovered: 2,
  nextCursor: "mentions-2",
};
const MENTIONS_EMPTY = {
  ...MENTIONS_PAGE,
  subject: null,
  entries: [],
  complete: true,
  sharedChannelRowsUncovered: 0,
  nextCursor: null,
};
const NOT_A_PAGE = { versionId: "v1" };

// A member's Group whose share covers only team/. The relay has already
// withheld its link to a file outside team/ before the message reached this
// computer (#3900), so the reads answer only covered files, and a preview
// holds the words that stand in for the withheld link.
const WITHHELD = "(a file not shared here)";
const SHARED_LINKS_PAGE = {
  ...CHAT_LINKS_PAGE,
  subject: { channelWireId: "wire-team" },
  sharedChannelRowsUncovered: 0,
  nextCursor: null,
  entries: [
    {
      ...CHAT_LINKS_PAGE.entries[0]!,
      file: { objectId: "obj-t", path: "team/plan.md", folder: "team" },
    },
  ],
};
const WITHHELD_MENTIONS_PAGE = {
  ...MENTIONS_PAGE,
  subject: { objectId: "obj-t", path: "team/plan.md" },
  sharedChannelRowsUncovered: 0,
  nextCursor: null,
  entries: [
    {
      ...MENTIONS_PAGE.entries[0]!,
      attachment: {
        ...MENTIONS_PAGE.entries[0]!.attachment,
        objectId: "obj-t",
        pathHint: "team/plan.md",
      },
      message: {
        ...MENTIONS_PAGE.entries[0]!.message,
        preview: `See team/plan.md and ${WITHHELD}`,
      },
      channelWireId: "wire-team",
      channelName: "Team",
      channelSlug: "team",
    },
  ],
};
const LONG = "x".repeat(32_769);
const STALE = "This cursor belongs to another index. Start again without it.";

type Answer = () => unknown;
const page =
  (value: unknown): Answer =>
  () =>
    value;
const failing =
  (message: string): Answer =>
  () => {
    throw new Error(message);
  };

function described(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { thrown: String(error) };
}
// Long arguments print as their length, so the recording stays readable.
const shown = (value: string) => (value.length > 200 ? `<${value.length} characters>` : value);

const IPC_ROWS = {
  chatLinks: chatOperations.chatLinks,
  chatFileMentionsPage: chatOperations.chatFileMentionsPage,
  ...linksOperations,
};
type IpcEvent = { trusted: boolean; workspaceId: string };
const IN_WORKSPACE: IpcEvent = { trusted: true, workspaceId: "ws-1" };

function ipcDoor() {
  const listeners = new Map<string, (event: IpcEvent, payload: unknown) => Promise<unknown>>();
  let answer: Answer = () => undefined;
  let handled: unknown[] = [];
  const boundary: OperationBoundary<IpcEvent, { workspaceId: string }> = {
    handle: (channel, listener) => {
      listeners.set(channel, listener);
    },
    assertTrustedSender: (event) => {
      if (!event.trusted) throw new Error("Refused an untrusted sender.");
    },
    async withActiveWorkspace(event, workspaceId, inactiveMessage, work) {
      if (workspaceId !== event.workspaceId) throw new Error(inactiveMessage);
      return await work({ workspaceId });
    },
  };
  const handler = (input: unknown, context: { operation?: { workspaceId: string } }) => {
    handled.push({ input, workspaceId: context.operation?.workspaceId });
    return answer();
  };
  registerOperations(
    boundary,
    IPC_ROWS,
    Object.fromEntries(
      Object.keys(IPC_ROWS).map((name) => [name, handler]),
    ) as unknown as OperationHandlers<typeof IPC_ROWS, IpcEvent, { workspaceId: string }>,
  );
  return async (
    name: keyof typeof IPC_ROWS,
    payload: Record<string, unknown>,
    reply: Answer,
    event = IN_WORKSPACE,
  ) => {
    const { channel } = IPC_ROWS[name];
    answer = reply;
    handled = [];
    const sent = {
      ...payload,
      ...(typeof payload.cursor === "string" ? { cursor: shown(payload.cursor) } : {}),
    };
    try {
      const result = await listeners.get(channel)!(event, payload);
      return { channel, payload: sent, event, handled, reply: result };
    } catch (error) {
      return { channel, payload: sent, event, handled, error: described(error) };
    }
  };
}

async function recordIpc() {
  const call = ipcDoor();
  const foreign = { trusted: true, workspaceId: "ws-2" };
  const untrusted = { trusted: false, workspaceId: "ws-1" };
  const ws = { workspaceId: "ws-1" };
  return {
    linksEdges: [
      await call("linksEdges", ws, page(EDGES_PAGE)),
      await call("linksEdges", { ...ws, cursor: "edges-2" }, page(EDGES_EMPTY)),
      await call("linksEdges", { ...ws, cursor: "stale" }, failing(STALE)),
      await call("linksEdges", ws, failing("Workspace engine is unavailable.")),
      await call("linksEdges", ws, page(NOT_A_PAGE)),
      await call("linksEdges", { ...ws, cursor: 5 }, page(EDGES_PAGE)),
      await call("linksEdges", { ...ws, cursor: LONG }, page(EDGES_PAGE)),
      await call("linksEdges", { ...ws, subject: { path: "a.md" } }, page(EDGES_PAGE)),
      await call("linksEdges", {}, page(EDGES_PAGE)),
      await call("linksEdges", ws, page(EDGES_PAGE), foreign),
      await call("linksEdges", ws, page(EDGES_PAGE), untrusted),
      await call("linksEdges", { workspaceId: "", cursor: LONG }, page(EDGES_PAGE)),
    ],
    linksIn: [
      await call("linksIn", { ...ws, subject: { path: "b.md" } }, page(IN_PAGE)),
      await call(
        "linksIn",
        { ...ws, subject: { objectId: "obj-b" }, cursor: "in-2" },
        page(IN_EMPTY),
      ),
      await call("linksIn", { ...ws, subject: { path: "gone.md" } }, page(null)),
      await call("linksIn", { ...ws, subject: { path: "b.md" }, cursor: "stale" }, failing(STALE)),
      await call("linksIn", { ...ws, subject: { path: "b.md" } }, page(NOT_A_PAGE)),
      await call("linksIn", ws, page(IN_PAGE)),
      await call("linksIn", { ...ws, subject: { path: "b.md", objectId: "obj-b" } }, page(IN_PAGE)),
      await call("linksIn", { ...ws, subject: { path: "" } }, page(IN_PAGE)),
      await call("linksIn", { ...ws, subject: { path: "b.md" }, extra: true }, page(IN_PAGE)),
      await call("linksIn", { ...ws, subject: { path: "b.md" } }, page(IN_PAGE), foreign),
      await call("linksIn", { ...ws, subject: { path: "b.md" } }, page(IN_PAGE), untrusted),
      await call(
        "linksIn",
        { workspaceId: "", subject: { path: "" }, cursor: LONG },
        page(IN_PAGE),
      ),
    ],
    linksResolve: [
      await call(
        "linksResolve",
        {
          ...ws,
          source: "a.md",
          literals: [
            { kind: "wikilink", literal: "b" },
            { kind: "markdown", literal: "new.md#top" },
            { kind: "wikilink", literal: "" },
          ],
        },
        page(RESOLVED),
      ),
      await call("linksResolve", { ...ws, source: "a.md", literals: [] }, page(RESOLVED_EMPTY)),
      await call("linksResolve", { ...ws, source: "a.md", literals: [] }, page(null)),
      await call(
        "linksResolve",
        { ...ws, source: "a.md", literals: [] },
        failing("Workspace engine is unavailable."),
      ),
      await call("linksResolve", { ...ws, source: "a.md" }, page(RESOLVED)),
      await call(
        "linksResolve",
        { ...ws, source: "a.md", literals: [{ kind: "other", literal: "b" }] },
        page(RESOLVED),
      ),
      await call(
        "linksResolve",
        {
          ...ws,
          source: "a.md",
          literals: Array.from({ length: 129 }, () => ({ kind: "wikilink", literal: "b" })),
        },
        page(RESOLVED),
      ),
      await call(
        "linksResolve",
        { ...ws, source: "a.md", literals: [], cursor: "c" },
        page(RESOLVED),
      ),
      await call("linksResolve", { ...ws, source: "a.md", literals: [] }, page(RESOLVED), foreign),
      await call(
        "linksResolve",
        { ...ws, source: "a.md", literals: [] },
        page(RESOLVED),
        untrusted,
      ),
      await call("linksResolve", { workspaceId: "", source: 5, literals: "x" }, page(RESOLVED)),
    ],
    chatLinks: [
      await call("chatLinks", { ...ws, channelWireId: "wire-general" }, page(CHAT_LINKS_PAGE)),
      await call(
        "chatLinks",
        { ...ws, channelWireId: "wire-general", cursor: "links-2" },
        page(CHAT_LINKS_EMPTY),
      ),
      await call("chatLinks", { ...ws, channelWireId: "wire-hidden" }, page(null)),
      await call(
        "chatLinks",
        { ...ws, channelWireId: "wire-general", cursor: "stale" },
        failing("chat-mention-access-changed"),
      ),
      await call("chatLinks", { ...ws, channelWireId: "wire-general" }, page(NOT_A_PAGE)),
      await call("chatLinks", ws, page(CHAT_LINKS_PAGE)),
      await call("chatLinks", { ...ws, group: "general" }, page(CHAT_LINKS_PAGE)),
      await call("chatLinks", { ...ws, channelWireId: "" }, page(CHAT_LINKS_PAGE)),
      await call(
        "chatLinks",
        { ...ws, channelWireId: "wire-general", extra: true },
        page(CHAT_LINKS_PAGE),
      ),
      await call("chatLinks", { channelWireId: "wire-general" }, page(CHAT_LINKS_PAGE)),
      await call(
        "chatLinks",
        { ...ws, channelWireId: "wire-general" },
        page(CHAT_LINKS_PAGE),
        foreign,
      ),
      await call(
        "chatLinks",
        { ...ws, channelWireId: "wire-general" },
        page(CHAT_LINKS_PAGE),
        untrusted,
      ),
      await call(
        "chatLinks",
        { workspaceId: "", channelWireId: "", cursor: LONG },
        page(CHAT_LINKS_PAGE),
      ),
      await call("chatLinks", { ...ws, channelWireId: "wire-team" }, page(SHARED_LINKS_PAGE)),
    ],
    chatFileMentionsPage: [
      await call("chatFileMentionsPage", ws, page(MENTIONS_PAGE)),
      await call(
        "chatFileMentionsPage",
        { ...ws, subject: { path: "a.md" }, cursor: "mentions-2" },
        page(MENTIONS_EMPTY),
      ),
      await call("chatFileMentionsPage", { ...ws, subject: { objectId: "obj-a" } }, page(null)),
      await call(
        "chatFileMentionsPage",
        { ...ws, cursor: "stale" },
        failing("chat-mention-access-changed"),
      ),
      await call("chatFileMentionsPage", ws, page(NOT_A_PAGE)),
      await call(
        "chatFileMentionsPage",
        { ...ws, subject: { path: "a.md", objectId: "obj-a" } },
        page(MENTIONS_PAGE),
      ),
      await call("chatFileMentionsPage", { ...ws, subject: "a.md" }, page(MENTIONS_PAGE)),
      await call("chatFileMentionsPage", { ...ws, extra: true }, page(MENTIONS_PAGE)),
      await call("chatFileMentionsPage", {}, page(MENTIONS_PAGE)),
      await call("chatFileMentionsPage", ws, page(MENTIONS_PAGE), foreign),
      await call("chatFileMentionsPage", ws, page(MENTIONS_PAGE), untrusted),
      await call(
        "chatFileMentionsPage",
        { workspaceId: "", subject: "a.md", cursor: LONG },
        page(MENTIONS_PAGE),
      ),
      await call(
        "chatFileMentionsPage",
        { ...ws, subject: { path: "team/plan.md" } },
        page(WITHHELD_MENTIONS_PAGE),
      ),
    ],
  };
}

const CLI_CWD = "cli-workspace";

async function cli(argv: string[], reply: Answer = page(null), env: Record<string, string> = {}) {
  const sent: unknown[] = [];
  const result = await executeCli({
    argv,
    cwd: CLI_CWD,
    env,
    request: async (request) => {
      // The working directory resolves against the test's own; the rest is exact.
      expect(request.args.cwd).toBe(resolve(CLI_CWD));
      sent.push(JSON.stringify({ ...request, args: { ...request.args, cwd: "<cwd>" } }));
      return reply();
    },
  });
  return { argv: argv.map(shown), ...(Object.keys(env).length ? { env } : {}), ...result, sent };
}

const desktopRefusal =
  (message: string): Answer =>
  () => {
    throw new DohcCliError(message);
  };

async function recordCli() {
  return {
    help: [
      await cli(["--help"]),
      await cli(["links"]),
      await cli(["links", "--help"]),
      await cli(["links", "edges", "--help"]),
      await cli(["links", "in", "-h"]),
      await cli(["links", "resolve", "--help"]),
      await cli(["chat", "--help"]),
      await cli(["chat", "links", "--help"]),
      await cli(["chat", "file-mentions", "--help"]),
      await cli(["links", "edgs"]),
      await cli(["link", "edges"]),
      await cli(["chat", "file-mention"]),
    ],
    linksEdges: [
      await cli(["links", "edges"], page(EDGES_PAGE)),
      await cli(["links", "edges", "--cursor", "edges-2"], page(EDGES_EMPTY)),
      await cli(["links", "edges", "--json"], page(EDGES_PAGE)),
      await cli(
        ["links", "edges", "--as-agent", "--cursor", "a", "--cursor", "b"],
        page(EDGES_EMPTY),
      ),
      await cli(["links", "edges", "--agent-id", "nova"], page(EDGES_EMPTY)),
      await cli(["links", "edges", "--cursor", "stale"], desktopRefusal(`dohc: ${STALE}`)),
      await cli(["links", "edges"], desktopRefusal("dohc: not inside a dohc workspace")),
      await cli(["links", "edges"], page(NOT_A_PAGE)),
      await cli(["links", "edges"], page(null)),
      await cli(["links", "edges", "extra"]),
      await cli(["links", "edges", "--cursor"]),
      await cli(["links", "edges", "--cursr", "a"]),
      await cli(["links", "edges", "--cursor", LONG]),
      await cli(["links", "edges", "extra", "--cursor", LONG]),
    ],
    linksIn: [
      await cli(["links", "in", '{"path":"b.md"}'], page(IN_PAGE)),
      await cli(["links", "in", '{"objectId":"obj-b"}', "--cursor", "in-2"], page(IN_EMPTY)),
      await cli(["links", "in", '{"path":"gone.md"}'], page(null)),
      await cli(["links", "in", '{"path":"gone.md"}', "--json"], page(null)),
      await cli(["links", "in", '{"path":"b.md"}', "--json"], page(IN_PAGE)),
      await cli(
        ["links", "in", '{"path":"b.md"}', "--cursor", "stale"],
        desktopRefusal(`dohc: ${STALE}`),
      ),
      await cli(["links", "in", '{"path":"b.md"}'], page(NOT_A_PAGE)),
      await cli(["links", "in"]),
      await cli(["links", "in", "b.md"]),
      await cli(["links", "in", '{"path":"b.md","objectId":"obj-b"}']),
      await cli(["links", "in", '{"path":"b.md"}', "extra"]),
      await cli(["links", "in", '{"path":"b.md"}', "--subject", "x"]),
      await cli(["links", "in", '{"path":""}', "--cursor", LONG]),
    ],
    linksResolve: [
      await cli(
        [
          "links",
          "resolve",
          "a.md",
          '[{"kind":"wikilink","literal":"b"},{"kind":"markdown","literal":"new.md#top"},{"kind":"wikilink","literal":""}]',
        ],
        page(RESOLVED),
      ),
      await cli(["links", "resolve", "a.md", "[]"], page(RESOLVED_EMPTY)),
      await cli(["links", "resolve", "a.md", "[]", "--json"], page(RESOLVED)),
      await cli(
        ["links", "resolve", "a.md", "[]"],
        desktopRefusal("dohc: Workspace engine is unavailable."),
      ),
      await cli(["links", "resolve", "a.md", "[]"], page(null)),
      await cli(["links", "resolve", "a.md"]),
      await cli(["links", "resolve"]),
      await cli(["links", "resolve", "a.md", '[{"kind":"other","literal":"b"}]']),
      await cli(["links", "resolve", "a.md", "[]", "extra"]),
      await cli(["links", "resolve", "a.md", "[]", "--cursor", "c"]),
      await cli(["links", "resolve", "", "{}"]),
    ],
    chatLinks: [
      await cli(["chat", "links", "general"], page(CHAT_LINKS_PAGE)),
      await cli(["chat", "links", "#general", "--cursor", "links-2"], page(CHAT_LINKS_EMPTY)),
      await cli(["chat", "links", "ch_ge"], page(CHAT_LINKS_PAGE)),
      await cli(
        ["chat", "links", "wire-general"],
        desktopRefusal("dohc: no such group: wire-general"),
      ),
      await cli(["chat", "links", "nope"], desktopRefusal("dohc: no such group: nope")),
      await cli(["chat", "links", "hidden"], page(null)),
      await cli(["chat", "links", "hidden", "--json"], page(null)),
      await cli(["chat", "links", "general", "--json", "--as-agent"], page(CHAT_LINKS_PAGE)),
      await cli(["chat", "links", "general"], page(CHAT_LINKS_EMPTY), { DOHC_CHAT_ACTOR: "agent" }),
      await cli(
        ["chat", "links", "general", "--cursor", "stale"],
        desktopRefusal("dohc: chat-mention-access-changed"),
      ),
      await cli(["chat", "links", "general"], page(NOT_A_PAGE)),
      await cli(["chat", "links"]),
      await cli(["chat", "links", "general", "extra"]),
      await cli(["chat", "links", "g".repeat(501)]),
      await cli(["chat", "links", "general", "--cursor", LONG]),
      await cli(["chat", "links", "g".repeat(501), "--cursor", LONG]),
      await cli(["chat", "links", "team"], page(SHARED_LINKS_PAGE)),
      await cli(["chat", "links", "team", "--json"], page(SHARED_LINKS_PAGE)),
    ],
    chatFileMentions: [
      await cli(["chat", "file-mentions"], page(MENTIONS_PAGE)),
      await cli(
        ["chat", "file-mentions", "--subject", '{"path":"a.md"}', "--cursor", "mentions-2"],
        page(MENTIONS_EMPTY),
      ),
      await cli(["chat", "file-mentions", "--subject", '{"objectId":"obj-a"}'], page(null)),
      await cli(["chat", "file-mentions", "--json"], page(MENTIONS_PAGE)),
      await cli(["chat", "file-mentions", "--json"], page(null)),
      await cli(
        ["chat", "file-mentions", "--cursor", "stale"],
        desktopRefusal("dohc: chat-mention-access-changed"),
      ),
      await cli(["chat", "file-mentions"], page(NOT_A_PAGE)),
      await cli(["chat", "file-mentions", "--subject", "a.md"]),
      await cli(["chat", "file-mentions", "--subject", '{"path":"a.md","objectId":"obj-a"}']),
      await cli(["chat", "file-mentions", "--subject", ""], page(MENTIONS_PAGE)),
      await cli(["chat", "file-mentions", "extra"]),
      await cli(["chat", "file-mentions", "--path", "a.md"]),
      await cli(["chat", "file-mentions", "--subject", '{"path":""}', "--cursor", LONG]),
      await cli(
        ["chat", "file-mentions", "--subject", '{"path":"team/plan.md"}'],
        page(WITHHELD_MENTIONS_PAGE),
      ),
      await cli(
        ["chat", "file-mentions", "--subject", '{"path":"team/plan.md"}', "--json"],
        page(WITHHELD_MENTIONS_PAGE),
      ),
    ],
  };
}

const TOKEN = "a".repeat(64);
const WORKSPACE_ID = "ws-1";

function channel(id: string, name: string, slug: string): ChatChannelSummary {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    name,
    slug,
    kind: "channel",
    type: "posts",
    purpose: "",
    createdAtMs: 1,
    updatedAtMs: 1,
    threadCount: 0,
    unreadCount: 0,
  };
}
const CHANNELS = [
  channel("channel-general", "General", "general"),
  channel("channel-design", "Design", "design"),
  channel("channel-deploys", "Deploys", "deploys"),
];
const WIRE_IDS: Record<string, string | null | Error> = {
  "channel-general": "wire-general",
  "channel-design": null,
  "channel-deploys": new Error("engine stopped"),
};

type SocketRead = (
  verb: string,
) => (workspace: CliRegistryWorkspace, input: unknown) => Promise<unknown>;

function withReads(options: CliServerOptions, read: SocketRead): CliServerOptions {
  return {
    ...options,
    reads: Object.fromEntries(
      ["chatLinks", "chatFileMentions", "linksEdges", "linksIn", "linksResolve"].map((verb) => [
        verb,
        read(verb),
      ]),
    ) as CliServerOptions["reads"],
  };
}

let scratch: string;
let root: string;
let receivedShare: string;
let outside: string;

beforeAll(async () => {
  scratch = await createTestScratch("dohc-link-read-doors-");
  root = join(scratch, "workspace");
  receivedShare = join(root, "shared-with-me", "from-sam");
  outside = join(scratch, "outside");
  await mkdir(receivedShare, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterAll(async () => {
  await removeTestScratch(scratch);
});

interface SocketCase {
  args: Record<string, unknown>;
  reply?: Answer;
  noReads?: boolean;
  readOnly?: boolean;
  cwd?: "workspace" | "received share" | "outside";
  token?: string;
  protocolVersion?: number;
}

async function socket(verb: string, test: SocketCase) {
  const seen = {
    reads: [] as unknown[],
    store: [] as string[],
    opened: 0,
    onRead: [] as unknown[],
    writes: 0,
    usage: [] as unknown[],
  };
  const workspace = {
    workspaceId: WORKSPACE_ID,
    rootPath: root,
    ...(test.readOnly ? { readOnly: true } : {}),
  };
  const store = {
    async listChannels() {
      seen.store.push("listChannels");
      return CHANNELS;
    },
    async ensureGeneralChannel() {
      seen.store.push("ensureGeneralChannel");
    },
    async getChannelWireId({ channelId }: { channelId: string }) {
      seen.store.push(`getChannelWireId ${channelId}`);
      const wireId = WIRE_IDS[channelId];
      if (wireId instanceof Error) throw wireId;
      return wireId ?? null;
    },
  };
  const context = {
    ...workspace,
    readOnly: Boolean(test.readOnly),
    store,
  } as unknown as CliWorkspaceContext;
  // Only the members these reads reach; a member they do not reach is absent.
  const base = {
    stateDir: join(scratch, "state"),
    listWorkspaces: () => [workspace],
    async openWorkspace() {
      seen.opened += 1;
      return context;
    },
    async connectedAgent() {
      return null;
    },
    dispatchedRunSecret: () => null,
    dispatchedAgent: () => null,
    dispatchedRunId: () => null,
    agentRunWorkspace: () => undefined,
    async onRead(_context: CliWorkspaceContext, target?: unknown) {
      seen.onRead.push(target ?? null);
    },
    async onWrite() {
      seen.writes += 1;
    },
    recordSuccess(invocation: unknown) {
      seen.usage.push(invocation);
    },
  } as unknown as CliServerOptions;
  const reply = test.reply ?? page(null);
  const options = test.noReads
    ? base
    : withReads(base, (name) => async (entry, input) => {
        seen.reads.push({ read: name, workspaceId: entry.workspaceId, input });
        return reply();
      });
  const cwd =
    test.cwd === "outside" ? outside : test.cwd === "received share" ? receivedShare : root;
  const line = await handleCliRequestLine(
    JSON.stringify({
      token: test.token ?? TOKEN,
      protocolVersion: test.protocolVersion ?? CLI_PROTOCOL_VERSION,
      verb,
      args: { cwd, ...test.args },
    }),
    TOKEN,
    options,
  );
  const args = Object.fromEntries(
    Object.entries(test.args).map(([key, value]) => [
      key,
      typeof value === "string" ? shown(value) : value,
    ]),
  );
  return {
    args,
    ...(test.cwd ? { cwd: test.cwd } : {}),
    ...(test.readOnly ? { readOnly: true } : {}),
    ...(test.noReads ? { noReads: true } : {}),
    ...(test.token ? { token: "wrong" } : {}),
    ...(test.protocolVersion ? { protocolVersion: test.protocolVersion } : {}),
    line,
    ...Object.fromEntries(
      Object.entries(seen).filter(([, value]) =>
        Array.isArray(value) ? value.length > 0 : value !== 0,
      ),
    ),
  };
}

async function refusals(verb: string, args: Record<string, unknown>, reply: Answer) {
  return [
    await socket(verb, { args, reply, token: "b".repeat(64) }),
    await socket(verb, { args, reply, protocolVersion: CLI_PROTOCOL_VERSION + 1 }),
    await socket(verb, { args, reply, cwd: "outside" }),
    await socket(verb, { args, reply, cwd: "received share" }),
    await socket(verb, { args, reply, readOnly: true }),
    await socket(verb, { args: { ...args, actor: "agent", agentId: "nova" }, reply }),
    await socket(verb, { args, noReads: true }),
    await socket(verb, { args, reply: page(NOT_A_PAGE) }),
    await socket(verb, { args: { ...args, extra: true }, reply }),
    await socket(verb, { args: { ...args, actor: "robot" }, reply }),
  ];
}

const human = { actor: "human" };

async function recordSocket() {
  return {
    linksEdges: [
      await socket("linksEdges", { args: human, reply: page(EDGES_PAGE) }),
      await socket("linksEdges", {
        args: { ...human, cursor: "edges-2" },
        reply: page(EDGES_EMPTY),
      }),
      await socket("linksEdges", { args: { ...human, cursor: "stale" }, reply: failing(STALE) }),
      await socket("linksEdges", {
        args: human,
        reply: failing("Workspace engine is unavailable."),
      }),
      await socket("linksEdges", { args: { ...human, cursor: 5 }, reply: page(EDGES_PAGE) }),
      await socket("linksEdges", { args: { ...human, cursor: LONG }, reply: page(EDGES_PAGE) }),
      await socket("linksEdges", { args: {}, reply: page(EDGES_PAGE) }),
      await socket("linksEdges", {
        args: { actor: "robot", cursor: LONG },
        reply: page(EDGES_PAGE),
      }),
      ...(await refusals("linksEdges", human, page(EDGES_PAGE))),
    ],
    linksIn: [
      await socket("linksIn", {
        args: { ...human, subject: { path: "b.md" } },
        reply: page(IN_PAGE),
      }),
      await socket("linksIn", {
        args: { ...human, subject: { objectId: "obj-b" }, cursor: "in-2" },
        reply: page(IN_EMPTY),
      }),
      await socket("linksIn", {
        args: { ...human, subject: { path: "gone.md" } },
        reply: page(null),
      }),
      await socket("linksIn", {
        args: { ...human, subject: { path: "b.md" }, cursor: "stale" },
        reply: failing(STALE),
      }),
      await socket("linksIn", { args: human, reply: page(IN_PAGE) }),
      await socket("linksIn", {
        args: { ...human, subject: { path: "b.md", objectId: "obj-b" } },
        reply: page(IN_PAGE),
      }),
      await socket("linksIn", {
        args: { actor: "robot", subject: { path: "" }, cursor: LONG },
        reply: page(IN_PAGE),
      }),
      ...(await refusals("linksIn", { ...human, subject: { path: "b.md" } }, page(IN_PAGE))),
    ],
    linksResolve: [
      await socket("linksResolve", {
        args: {
          ...human,
          source: "a.md",
          literals: [
            { kind: "wikilink", literal: "b" },
            { kind: "markdown", literal: "new.md#top" },
            { kind: "wikilink", literal: "" },
          ],
        },
        reply: page(RESOLVED),
      }),
      await socket("linksResolve", {
        args: { ...human, source: "a.md", literals: [] },
        reply: page(RESOLVED_EMPTY),
      }),
      await socket("linksResolve", {
        args: { ...human, source: "a.md", literals: [] },
        reply: page(null),
      }),
      await socket("linksResolve", {
        args: { ...human, source: "a.md", literals: [] },
        reply: failing("Workspace engine is unavailable."),
      }),
      await socket("linksResolve", { args: { ...human, source: "a.md" }, reply: page(RESOLVED) }),
      await socket("linksResolve", {
        args: { ...human, source: "a.md", literals: [{ kind: "other", literal: "b" }] },
        reply: page(RESOLVED),
      }),
      await socket("linksResolve", {
        args: { actor: "robot", source: 5, literals: "x" },
        reply: page(RESOLVED),
      }),
      ...(await refusals(
        "linksResolve",
        { ...human, source: "a.md", literals: [] },
        page(RESOLVED),
      )),
    ],
    chatLinks: [
      await socket("chatLinks", {
        args: { ...human, group: "General" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "#general", cursor: "links-2" },
        reply: page(CHAT_LINKS_EMPTY),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "ch_general" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "channel-general" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "ch_ge" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "ch_de" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "nope" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "wire-general" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "design" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "deploys" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", { args: { ...human, group: "general" }, reply: page(null) }),
      await socket("chatLinks", {
        args: { ...human, group: "general", cursor: "stale" },
        reply: failing("chat-mention-access-changed"),
      }),
      await socket("chatLinks", { args: { ...human, group: "general" }, noReads: true }),
      await socket("chatLinks", { args: { ...human, group: "nope" }, noReads: true }),
      await socket("chatLinks", {
        args: { ...human, channelWireId: "wire-general" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, channelWireId: "wire-general", cursor: "links-2" },
        reply: page(CHAT_LINKS_EMPTY),
      }),
      await socket("chatLinks", {
        args: { ...human, channelWireId: "wire-hidden" },
        reply: page(null),
      }),
      await socket("chatLinks", {
        args: { ...human, group: "general", channelWireId: "wire-general" },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", { args: { ...human, group: "" }, reply: page(CHAT_LINKS_PAGE) }),
      await socket("chatLinks", { args: human, reply: page(CHAT_LINKS_PAGE) }),
      await socket("chatLinks", {
        args: { ...human, group: "g".repeat(501), cursor: LONG },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { actor: "robot", group: "g".repeat(501), cursor: LONG },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { actor: "robot", channelWireId: "", cursor: LONG },
        reply: page(CHAT_LINKS_PAGE),
      }),
      await socket("chatLinks", {
        args: { ...human, channelWireId: "wire-team" },
        reply: page(SHARED_LINKS_PAGE),
      }),
      ...(await refusals("chatLinks", { ...human, group: "general" }, page(CHAT_LINKS_PAGE))),
      ...(await refusals(
        "chatLinks",
        { ...human, channelWireId: "wire-general" },
        page(CHAT_LINKS_PAGE),
      )),
    ],
    chatFileMentions: [
      await socket("chatFileMentions", { args: human, reply: page(MENTIONS_PAGE) }),
      await socket("chatFileMentions", {
        args: { ...human, subject: { path: "a.md" }, cursor: "mentions-2" },
        reply: page(MENTIONS_EMPTY),
      }),
      await socket("chatFileMentions", {
        args: { ...human, subject: { objectId: "obj-a" } },
        reply: page(null),
      }),
      await socket("chatFileMentions", {
        args: { ...human, cursor: "stale" },
        reply: failing("chat-mention-access-changed"),
      }),
      await socket("chatFileMentions", {
        args: { ...human, subject: { path: "a.md", objectId: "obj-a" } },
        reply: page(MENTIONS_PAGE),
      }),
      await socket("chatFileMentions", {
        args: { actor: "robot", subject: "a.md", cursor: LONG },
        reply: page(MENTIONS_PAGE),
      }),
      await socket("chatFileMentions", {
        args: { ...human, subject: { path: "team/plan.md" } },
        reply: page(WITHHELD_MENTIONS_PAGE),
      }),
      ...(await refusals("chatFileMentions", human, page(MENTIONS_PAGE))),
    ],
  };
}

// One line per case under a heading per door and read, so a changed case
// names itself in a diff.
function recorded(doors: Record<string, Record<string, unknown[]>>): string {
  return (
    Object.entries(doors)
      .flatMap(([door, reads]) =>
        Object.entries(reads).flatMap(([read, cases]) => [
          `## ${door} ${read}`,
          ...cases.map((entry) => JSON.stringify(entry)),
        ]),
      )
      .join("\n") + "\n"
  );
}

it("keeps every desktop door of the five link reads as recorded", async () => {
  const doors = { ipc: await recordIpc(), socket: await recordSocket(), cli: await recordCli() };
  await expect(recorded(doors)).toMatchFileSnapshot("./linkReadDoors.expected.txt");
});
