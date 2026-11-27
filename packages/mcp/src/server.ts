// The dohc MCP server. The user's AI tool (Claude Code, Codex) is the client,
// launching it as a stdio child via its own config:
//   { mcpServers: { dohc: { command, args: ["--workspace", root, "--home", home] } } }
// Stdio is scoped by construction — only the configured tool talks to it — so
// there is no shared-secret auth to manage (a persistent HTTP server would
// need one). Every tool routes through src/tools.ts, which contains all path
// validation; this file is only registration + transport.

import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HistoryOperationId } from "@dohc/workspace-contracts/history-operation";
import { ShareCopyInput } from "@dohc/workspace-contracts/share-copy";
import {
  ShareLinkAgentDisconnectInput,
  ShareLinkAgentsInput,
} from "@dohc/workspace-contracts/share-link-agents";
import { GUIDE_TEXT, GUIDES } from "./guides";
import { MCP_TOOL_LEVELS } from "./mcpAdvertisement";
import { OwnerAppPublicationRequest } from "@dohc/cli/app-publication";
import { AgentMembersRequest } from "@dohc/cli/members";
import { DatasetAdminRequest, DatasetRequest } from "@dohc/cli/dataset";
import {
  chatWorkReportSchema,
  chatWatchInputSchema,
  cliAgentIdSchema,
  LIVE_DOCUMENT_REASON_STEPS,
  MAX_VERSION_NAME_LENGTH,
  documentAgentNameSchema,
  documentEditTextSchema,
  reportedAgentPartSchema,
  requestIdSchema,
  versionResolutionSchema,
} from "@dohc/cli/protocol";
import {
  isShareAccessValue,
  SHARE_ACCESS_VALUES,
  type ShareAccess,
} from "@dohc/security-contract/share-selector";
import {
  MCP_TOOL_CAPABILITIES,
  heldNoteChange,
  DECLARED_TOOLS,
  DECLARED_WRITE_TOOLS,
  requestDeclaredTool,
  requestDeclaredWriteTool,
  makeLink,
  readOperation,
  undoOperation,
  listVersions,
  compareVersion,
  listVersionConflicts,
  createVersion,
  switchVersion,
  mergeVersion,
  updateVersion,
  archiveVersion,
  resolveVersionConflict,
  getShareCopyDetails,
  listLinkAgents,
  readOwnerSetup,
  disconnectLinkAgent,
  createDocument,
  createRecord,
  dataset,
  publishApp,
  members,
  createWorkspaceDirectory,
  listAutomationRuns,
  listAutomations,
  switchAutomation,
  listGroups,
  createGroup,
  pressButton,
  inspectButtons,
  queryCollection,
  readAutomationRun,
  retryAutomationRun,
  readRecord,
  setRecordFields,
  waitForMessages,
  listFileChats,
  readChat,
  replyToChat,
  reportNothing,
  startGroupChat,
  startFileChat,
  reportedAgent,
  createApp,
  duplicateWorkspaceFile,
  deleteWorkspacePath,
  detectApps,
  editDocument,
  importData,
  listWorkspaceFiles,
  listChanges,
  listKeptCopies,
  listNotices,
  listWorkspaces,
  moveWorkspacePath,
  queryDatabase,
  readChange,
  readDocument,
  readHeldChange,
  readWorkspaceFile,
  saveKeptCopy,
  discardProtectedCopy,
  saveRecoveryCopy,
  retryKeptEdits,
  stopAgain,
  keepOutsideChange,
  listLiveDocuments,
  stopLiveEditing,
  listRetainedCopies,
  deleteRetainedCopies,
  searchWorkspaceFiles,
  testApp,
  writeWorkspaceFile,
  workspaceStatus,
  servedWorkspace,
  stopWorkspaceSync,
  type ToolContext,
} from "./tools";

export const MCP_USAGE = [
  "Usage: dohc-mcp [options]",
  "",
  "Run dohc's stdio MCP server for one local workspace while the dohc desktop app is open.",
  "Copy the ready-to-use command and arguments for a workspace from Settings › Agents in dohc.",
  "",
  "Options:",
  "  --workspace <path>       Workspace folder to serve (default: current directory).",
  "  --home <path>            dohc desktop state directory (copy from Settings › Agents; required for desktop-backed tools).",
  "  --agent-id <id>          Connected agent id from Settings › Agents.",
  "  --share-access <level>   Restrict tools to a share level: view, comment, or edit.",
  "  --tool <name>            Expose only this MCP tool. Repeat for more tools.",
  "  --help, -h               Show this help and exit.",
].join("\n");

export function parseArgs(argv: string[]): ToolContext {
  let root = nonEmptyArg(process.cwd(), "workspace root");
  let home = nonEmptyArg(process.env.HOME ?? process.cwd(), "home path");
  let shareAccess: ShareAccess | undefined;
  let agentId: string | undefined;
  const tools = new Set<keyof typeof MCP_TOOL_CAPABILITIES>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--workspace") root = pathArg(argv[++i], "--workspace");
    else if (flag === "--home") home = pathArg(argv[++i], "--home");
    else if (flag === "--share-access") shareAccess = shareAccessArg(argv[++i]);
    else if (flag === "--tool") tools.add(toolArg(argv[++i]));
    else if (flag === "--agent-id") agentId = agentIdArg(argv[++i]);
    else
      throw new Error(`Unknown argument ${JSON.stringify(flag)}. Run dohc-mcp --help for usage.`);
  }
  const runId = process.env.DOHC_RUN_ID?.trim();
  return {
    root,
    home,
    ...(shareAccess ? { shareAccess } : {}),
    ...(tools.size > 0 ? { tools } : {}),
    ...(runId ? { runId } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

// A malformed id is refused, never dropped: without it the agent would work
// unnamed and miss its own messages.
function agentIdArg(value: string | undefined): string {
  if (cliAgentIdSchema.safeParse(value).success) return value!;
  const received = value === undefined ? "no value" : JSON.stringify(value);
  throw new Error(
    `--agent-id must be an agent's id from Settings › Agents. Received: ${received}.`,
  );
}

function pathArg(value: string | undefined, name: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.startsWith("-")) {
    throw new Error(`${name} requires a non-empty path value (use ./ for a path starting with -).`);
  }
  return trimmed;
}

function nonEmptyArg(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} requires a non-empty value`);
  return trimmed;
}

// An unreadable level is refused, never read as the narrowest one: a guess
// here decides which write tools an agent is offered.
function shareAccessArg(value: string | undefined): ShareAccess {
  if (isShareAccessValue(value)) return value;
  const received = value === undefined ? "no value" : JSON.stringify(value);
  throw new Error(
    `--share-access must be one of ${SHARE_ACCESS_VALUES.join(", ")}. Received: ${received}.`,
  );
}

function isToolName(value: string | undefined): value is keyof typeof MCP_TOOL_CAPABILITIES {
  return value !== undefined && Object.hasOwn(MCP_TOOL_CAPABILITIES, value);
}

// A misspelled tool is refused, never read as offering every tool.
function toolArg(value: string | undefined): keyof typeof MCP_TOOL_CAPABILITIES {
  if (isToolName(value)) return value;
  const received = value === undefined ? "no value" : JSON.stringify(value);
  throw new Error(
    `--tool must name a dohc tool, such as dohc_reply_to_chat. Received: ${received}.`,
  );
}

// A misspelled argument is refused, never dropped: a dropped filter widens a
// read, and a dropped check unguards a write.
function strictArguments<Shape extends z.ZodRawShape>(shape: Shape) {
  const names = Object.keys(shape);
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") return undefined;
      const unknown = issue.keys.map((key) => JSON.stringify(key)).join(", ");
      return `Unknown argument${issue.keys.length === 1 ? "" : "s"} ${unknown}. This tool takes ${names.join(", ") || "no arguments"}.`;
    },
  });
}

function text(structuredContent: Record<string, unknown> | null) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
    ...(structuredContent === null ? {} : { structuredContent }),
    ...(structuredContent?.ok === false || structuredContent?.kind === "partial"
      ? { isError: true }
      : {}),
  };
}

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
const READ_SERVER = { ...READ, openWorldHint: true } as const satisfies ToolAnnotations;
const ADD = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const satisfies ToolAnnotations;
const ADD_SERVER = { ...ADD, openWorldHint: true } as const satisfies ToolAnnotations;
const CHANGE = { ...ADD, destructiveHint: true } as const satisfies ToolAnnotations;
const CHANGE_SERVER = { ...CHANGE, openWorldHint: true } as const satisfies ToolAnnotations;

const DECLARED_WRITE_ANNOTATIONS: Record<keyof typeof DECLARED_WRITE_TOOLS, ToolAnnotations> = {
  dohc_retry_chat_run: ADD,
  dohc_restore_protected_copy: CHANGE,
  dohc_inbox_add: ADD,
  dohc_inbox_archive: CHANGE,
  dohc_inbox_move: CHANGE,
  dohc_resume_live_editing: CHANGE,
  dohc_share_member_app: CHANGE_SERVER,
  dohc_fork_member_app: ADD,
  dohc_promote_member_app: ADD,
  dohc_withdraw_member_app: CHANGE_SERVER,
  dohc_set_member_app_sharing: CHANGE_SERVER,
  dohc_create_drawing: ADD,
  dohc_edit_drawing: CHANGE,
  dohc_use_server_for_automations: CHANGE_SERVER,
  dohc_create_incoming_webhook: ADD_SERVER,
  dohc_convert_notes: CHANGE_SERVER,
};

export const MCP_INSTRUCTIONS = [
  "dohc serves one workspace folder: files, live Markdown documents, Collections, apps, automations, and chat, with History and Versions.",
  "- Markdown files are live documents. Create them with dohc_create_document, read them with dohc_read_document, and change them with dohc_edit_document. dohc_write_file writes every other file and refuses Markdown.",
  "- .excalidraw files are live drawings: dohc_create_drawing, dohc_read_drawing, and dohc_edit_drawing.",
  "- A document Collection is a folder of Markdown records with collection.yaml: use dohc_query_collection, dohc_create_record, and dohc_set_record_fields. A transactional Collection (a dataset) has dataset.json, SQLite tables, and approved operations: use dohc_dataset.",
  "- An app is a folder with app.publish.json. In a workspace you own, dohc_publish_app action verifyFrontend compiles and runs it in dohc's sandbox; dohc_test_app only checks the folder. Then prepareLocal, approve, and launchLocal.",
  "- dohc_dataset, dohc_collection_access, and dohc_publish_app fill in workspaceId for this workspace when you leave it out.",
  `- Read a guide before you author: ${Object.keys(GUIDES)
    .map((name) => `dohc://guides/${name}`)
    .join(", ")}. dohc://workspace/info names this workspace.`,
].join("\n");

const SAID_IN_TOOL_DESCRIPTION = new Set(["datasetPath", "expectedDatasetId"]);

function forServedWorkspace<
  Union extends z.ZodDiscriminatedUnion<readonly z.ZodObject<z.ZodRawShape, z.core.$strict>[]>,
>(union: Union): Union {
  const options = union.options.map((option) =>
    option.safeExtend(
      Object.fromEntries(
        Object.entries(option.shape as Record<string, z.ZodType>).flatMap(([key, field]) =>
          key === "workspaceId"
            ? [[key, field.optional()]]
            : SAID_IN_TOOL_DESCRIPTION.has(key)
              ? [[key, field.meta({ description: undefined })]]
              : [],
        ),
      ),
    ),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]];
  return z.discriminatedUnion("action", options, {
    error: union._zod.def.error as z.core.$ZodErrorMap,
  }) as never;
}

async function inServedWorkspace<Result>(
  ctx: ToolContext,
  request: Record<string, unknown>,
  run: (request: Record<string, unknown>) => Promise<Result>,
) {
  if (request.workspaceId !== undefined) return run(request);
  const { workspaceId } = await servedWorkspace(ctx);
  if (workspaceId === null)
    return {
      ok: false as const,
      reason:
        "This folder is not a workspace in dohc's list. Pass workspaceId from dohc_list_workspaces.",
    };
  return run({ ...request, workspaceId });
}

export function createDohcMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "dohc", version: "0.3.0" },
    { instructions: MCP_INSTRUCTIONS },
  );

  for (const [name, { description }] of Object.entries(GUIDES) as [
    keyof typeof GUIDES,
    (typeof GUIDES)[keyof typeof GUIDES],
  ][]) {
    server.registerResource(
      `guide-${name}`,
      `dohc://guides/${name}`,
      { description, mimeType: "text/markdown" },
      (uri) => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE_TEXT[name] }],
      }),
    );
  }
  server.registerResource(
    "workspace-info",
    "dohc://workspace/info",
    {
      description:
        "This workspace's workspaceId, name, folder, and the share level this server offers.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await servedWorkspace(ctx)),
        },
      ],
    }),
  );

  let waits = 0;
  const level = ctx.shareAccess ?? "owner";
  function register<InputArgs extends z.ZodRawShape>(
    name: keyof typeof MCP_TOOL_CAPABILITIES,
    config: { description: string; inputSchema: InputArgs; annotations: ToolAnnotations },
    handler: ToolCallback<ReturnType<typeof strictArguments<InputArgs>>>,
  ) {
    if (MCP_TOOL_LEVELS[name].includes(level) && (ctx.tools?.has(name) ?? true)) {
      const inputSchema = strictArguments(config.inputSchema);
      server.registerTool<z.ZodRawShape, typeof inputSchema>(
        name,
        { description: config.description, inputSchema, annotations: config.annotations },
        handler,
      );
    }
  }

  register(
    "dohc_read_share_copy",
    {
      description:
        "Read one owned grant's share code and named-account invite link. Requires the original workspace and its signed-in owner account. Ended grants return only status; unknown and link grants are refused.",
      inputSchema: ShareCopyInput.shape,
      annotations: READ_SERVER,
    },
    async (args) => text(await getShareCopyDetails(ctx, args)),
  );

  register(
    "dohc_list_link_agents",
    {
      description:
        "List the agents signed in through one share link, 50 a page. Requires the original workspace and its signed-in owner account. Find the link's shareId and grantId with `dohc access sharing granted`. reportedName is the name the agent's client reported; dohc cannot check it. Pass nextCursor as cursor until it is null.",
      inputSchema: ShareLinkAgentsInput.shape,
      annotations: READ_SERVER,
    },
    async (args) => text(await listLinkAgents(ctx, args)),
  );

  register(
    "dohc_disconnect_link_agent",
    {
      description:
        "End one agent's connection through a share link. The link and its other agents keep working. Requires the original workspace and its signed-in owner account. Find connectionId with dohc_list_link_agents.",
      inputSchema: ShareLinkAgentDisconnectInput.shape,
      annotations: CHANGE_SERVER,
    },
    async (args) => text(await disconnectLinkAgent(ctx, args)),
  );

  register(
    "dohc_list_automations",
    {
      description:
        "Read automation definitions and on/off file state in a Collection, including shares. Shared run history and host runtime are unavailable.",
      inputSchema: { collectionPath: z.string().min(1).max(4096) },
      annotations: READ_SERVER,
    },
    async (args) => text(await listAutomations(ctx, args)),
  );
  register(
    "dohc_read_automation_host",
    {
      description:
        "Read which of the owner's computers, or the dohc server, runs this workspace's automations and schedules. kind relay gives the generation that dohc_use_server_for_automations needs, the host's installId (server for the dohc server), and handoverFrom while a computer hands over.",
      inputSchema: {},
      annotations: READ_SERVER,
    },
    async () => text(await readOwnerSetup(ctx, "automationHost")),
  );
  register(
    "dohc_list_incoming_webhooks",
    {
      description:
        "List this workspace's incoming webhooks: each one's name, Collection, paused state, and recent deliveries. Never returns their addresses. List before you retry a create whose result you don't know.",
      inputSchema: {},
      annotations: READ_SERVER,
    },
    async () => text(await readOwnerSetup(ctx, "webhookList")),
  );
  register(
    "dohc_switch_automation",
    {
      description:
        "Change only one automation's enabled value. Read definitions first and provide their contentHash. Reformat confirms losing comments and hand formatting. After an unknown desktop save, read definitions and sync state before retrying; a stale base remains a conflict. A pending save is waiting to sync; acceptance records history, not host execution.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        automation: z.string().min(1).max(64),
        enabled: z.boolean(),
        expectedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
        reformat: z.boolean().optional(),
        submitId: requestIdSchema,
      },
      annotations: CHANGE_SERVER,
    },
    async (args) => text(await switchAutomation(ctx, args)),
  );

  register(
    "dohc_publish_app",
    {
      description:
        "Verify, approve, launch, and publish a local app, a folder with app.publish.json, as its owner on this computer. verifyFrontend takes exactly one of appRoot or publicationId, then compiles and runs the app in dohc's offline sandbox against an empty ephemeral Collection without changing live data; run it before you approve or hand over an app. Local: prepareLocal, approve, then launchLocal. Share link: createLink with a stable operationId, so a retry returns the same link, then prepare and approve; these need a workspace that syncs with a server (see dohc_workspace_status). A link URL is a bearer credential: keep its secret yourself, never send it to dohc, and append the returned appQuery before the URL's fragment. In a workspace you joined, only Personal apps work. dohc://guides/apps lists every action, staging with Collection changes, apps for members, and Personal apps.",
      inputSchema: { request: forServedWorkspace(OwnerAppPublicationRequest) },
      annotations: CHANGE_SERVER,
    },
    async ({ request }) =>
      text(await inServedWorkspace(ctx, request, (filled) => publishApp(ctx, filled))),
  );

  register(
    "dohc_members",
    {
      description:
        "Do what the Members page does, in a workspace you own or joined: list people, invites, and removed accounts; invite by email (dohc emails them an invitation when the server sends email, and inviting the same address again emails it again; they join when they sign in to dohc with that address); remove someone; let a removed account back in; make someone an admin or a member; set what members can do (view, comment, or edit); show or set what members can do in one Group (group is a Group name or id; level comment lets them post, view lets them read, none hides the Group, null removes the Group's own access so it takes the member level; leave level out to read it); set or clear folder access (folder with change containing a workspace-relative folder and members plus people, or clear: true; use ruleId and revision from list to target a specific rule; members null hides the folder; people are email and level pairs); remove an unknown marker (folderMarker with folder); turn the invite link on or off or reset it; end membership for everyone; or delete a message in a Group or a file's Comments (deleteMessage, with its threadId and messageId). The server decides what your role allows: members see names and roles and delete their own messages; admins also invite, remove members, let them back in, set the level and folder or Group access, manage the invite link, and delete any message in a Group or Comments; only the owner changes roles or ends membership. A person is a memberId from list, or an email. Removing someone or ending membership ends their access; copies already on their computers stay. Deleting a message can't be undone. It shows as deleted everywhere it syncs, but people who already read it may keep a copy. Ask the person you work for before you remove anyone, hide a Group, narrow folder access, end membership, or delete someone else's message.",
      inputSchema: { request: AgentMembersRequest },
      annotations: CHANGE_SERVER,
    },
    async ({ request }) => {
      // A Members page the relay does not list is a failure, as the CLI reports it.
      const result = await members(ctx, request);
      return {
        ...text(result),
        ...("status" in result && result.status === "refused" ? { isError: true } : {}),
      };
    },
  );

  register(
    "dohc_dataset",
    {
      description:
        "Create, prepare, approve, inspect, and use transactional Collections (dataset.json, SQLite tables, and approved operations) in the owning workspace. Address one with datasetPath, its dataset.json path relative to the MCP server folder, such as tracker/dataset.json, never a folder or datasetId; list returns these paths, and a move changes them. expectedDatasetId refuses the request when the path now names another Collection. create takes definition, a dataset.json descriptor object (formatVersion 1 or 2), and approves revision 1. prepare takes descriptorPath; approve takes its preparationId and revisionSha256. invoke runs an approved operation with its described revision and revisionSha256 and a stable idempotencyKey. Generated create operations take input { values: { <fieldId>: value } }, and edit operations add id and expectedVersion; field ids come from describe. Apps bind to these Collections and have no separate store. export writes a private recovery archive, with private records and retry credentials, to an absolute savePath outside the workspace. dohc://guides/collections lists every action's fields, migrations, history restore, permissions, and recovery.",
      inputSchema: { request: forServedWorkspace(DatasetRequest) },
      annotations: CHANGE_SERVER,
    },
    async ({ request }) =>
      text(await inServedWorkspace(ctx, request, (filled) => dataset(ctx, filled))),
  );

  register(
    "dohc_collection_access",
    {
      description:
        "As an Admin of a workspace you joined, read a Collection and manage its access and rules on the workspace's server. Address it with datasetPath, its dataset.json path relative to the MCP server folder. list and describe show every Collection on the server with the reads the Owner has. invoke runs a read operation with its described revision and a stable retry key; a write needs a grant that holds it. permissions lists per-person grants, the workspace defaults, and rules: the approved revision, revisionSha256, and the actions grants and defaults may hold. setDefaults sets the actions each member level holds (view, comment, edit), named under that revision; View and Comment hold only read-only actions. setGrant and removeGrant change one person's grant. create makes a new Collection from a dataset.json definition and approves it as you. prepareSchemaChange and prepareMigration prepare a rules change for review, migrationPreviewPage reads more of the records it changes, and approveMigration or discardMigration ends the review. approval says who approved the rules the Collection runs. The server refuses anyone who is not an Admin, and a Collection kept on the Owner's computer. Ask the person you work for before you narrow anyone's access or approve a rules change.",
      inputSchema: { request: forServedWorkspace(DatasetAdminRequest) },
      annotations: CHANGE_SERVER,
    },
    async ({ request }) =>
      text(await inServedWorkspace(ctx, request, (filled) => dataset(ctx, filled))),
  );

  register(
    "dohc_list_workspaces",
    {
      description: "List the local dohc workspaces in the desktop registry.",
      inputSchema: {},
      annotations: READ,
    },
    async () => text(await listWorkspaces(ctx)),
  );

  register(
    "dohc_workspace_status",
    {
      description:
        "Report whether this workspace is local-only or cloud-synced. In the owning workspace, also list live documents whose edits the server refused, as keptEdits, and shared notes whose edits wait for the server, as pendingShare, and new notes shared by a link or with a person, which the server has no file for yet, as pendingShareWhileOpen.",
      inputSchema: {},
      annotations: READ,
    },
    async () => text(await workspaceStatus(ctx)),
  );

  register(
    "dohc_stop_workspace_sync",
    {
      description:
        "Stop this computer's sync for the owning workspace after saving live document edits. Keep local work, shares, history, and protected-file keys. Groups you joined and received-share mounts keep syncing. Record who paused and when. Resume in Settings.",
      inputSchema: {},
      annotations: CHANGE,
    },
    async () => text(await stopWorkspaceSync(ctx, agentName())),
  );

  for (const { mcp, input } of Object.values(DECLARED_TOOLS)) {
    register(
      mcp.tool,
      { description: mcp.description, inputSchema: input.shape, annotations: READ },
      async (args) => text(await requestDeclaredTool(ctx, mcp.tool, args)),
    );
  }
  for (const { mcp, socket } of Object.values(DECLARED_WRITE_TOOLS)) {
    const schema = "input" in mcp && mcp.input ? mcp.input : socket.input;
    register(
      mcp.tool,
      {
        description: mcp.description,
        inputSchema: schema.shape,
        annotations: DECLARED_WRITE_ANNOTATIONS[mcp.tool],
      },
      async (args) => text(await requestDeclaredWriteTool(ctx, mcp.tool, args)),
    );
  }
  register(
    "dohc_duplicate_file",
    {
      description:
        "Duplicate one regular file beside its source with a fresh identity. Owner workspace only. Undo removes the copy while it is unchanged.",
      inputSchema: { path: z.string() },
      annotations: ADD,
    },
    async (args) => text(await duplicateWorkspaceFile(ctx, args, agentName())),
  );
  register(
    "dohc_read_operation",
    {
      description:
        "List the paths changed by one operation, up to 50 per page. Returns change references and paths without retained contents, and a file move's link update state. Owner workspace only.",
      inputSchema: { operationId: HistoryOperationId, cursor: z.string().optional() },
      annotations: READ,
    },
    async (args) => text(await readOperation(ctx, args)),
  );
  register(
    "dohc_undo_operation",
    {
      description:
        "Undo a delete, move, or rename by its operation id. Requires dohc open and the owning workspace. Returns History restoration state, restored paths, and remaining paths with reasons and retry flags. Undo again to retry each remaining path marked retry. Undo of a move also reverses its link updates.",
      inputSchema: { operationId: HistoryOperationId },
      annotations: CHANGE,
    },
    async (args) => text(await undoOperation(ctx, args, agentName())),
  );
  register(
    "dohc_list_versions",
    {
      description:
        "List the workspace's versions and which one is active. Archived versions are hidden unless includeArchived is true. canMergeIntoMain is true for a version that started from Main. A version's madeFromVersionId is the id of the version it was made from. Owner workspace only.",
      inputSchema: { includeArchived: z.boolean().optional() },
      annotations: READ,
    },
    async (args) => text(await listVersions(ctx, args)),
  );
  register(
    "dohc_compare_version",
    {
      description:
        "Read one page of files that differ between a version and Main. Name the version by its name or id from dohc_list_versions. currentText is Main's text and incomingText the version's; binary files carry no text. Files History does not track and secret files are left out. Continue with afterPath set to nextAfterPath until it is null. Owner workspace only.",
      inputSchema: {
        version: z.string().min(1).max(200),
        afterPath: z.string().min(1).max(4096).optional(),
      },
      annotations: READ,
    },
    async (args) => text(await compareVersion(ctx, args)),
  );
  register(
    "dohc_list_version_conflicts",
    {
      description:
        "Read one page of open conflicts from merges and from sync, with each side's text. origin sync means two computers changed the file; waiting says another computer's newer version waits until that conflict is resolved. Files History does not track are left out. Continue with afterConflictId set to nextAfterConflictId until it is null. Owner workspace only.",
      inputSchema: { afterConflictId: z.string().min(1).max(200).optional() },
      annotations: READ,
    },
    async (args) => text(await listVersionConflicts(ctx, args)),
  );
  register(
    "dohc_create_version",
    {
      description:
        "Create a version from the active one and switch the workspace folder to it. The new version starts as a copy. Refuses a name another version has. First saves the edits open in dohc, and refuses when it can't. Owner workspace only.",
      inputSchema: { name: z.string().min(1).max(MAX_VERSION_NAME_LENGTH) },
      annotations: CHANGE,
    },
    async (args) => text(await createVersion(ctx, args)),
  );
  register(
    "dohc_switch_version",
    {
      description:
        "Switch the workspace folder to a version, named by its name or id from dohc_list_versions. dohc first saves the active version's files and the edits open in dohc, and refuses when it can't. Owner workspace only.",
      inputSchema: { version: z.string().min(1).max(200) },
      annotations: CHANGE,
    },
    async (args) => text(await switchVersion(ctx, args)),
  );
  register(
    "dohc_merge_version",
    {
      description:
        "Merge a version into Main, named by its name or id from dohc_list_versions. Only versions made from Main can merge into Main. Returns the merged and conflict counts and the first page of open conflicts, as dohc_list_version_conflicts does. First saves the edits open in dohc, and refuses when it can't. Owner workspace only.",
      inputSchema: { version: z.string().min(1).max(200) },
      annotations: CHANGE,
    },
    async (args) => text(await mergeVersion(ctx, args)),
  );
  register(
    "dohc_update_version",
    {
      description:
        "Bring Main's changes into a version made from Main, named by its name or id from dohc_list_versions. Returns the merged and conflict counts, the count of protected files both sides changed (left as the version has them), and the first page of open conflicts. In an update's conflicts, current is the version and incoming is Main. First saves the edits open in dohc, and refuses when it can't. Owner workspace only.",
      inputSchema: { version: z.string().min(1).max(200) },
      annotations: CHANGE,
    },
    async (args) => text(await updateVersion(ctx, args)),
  );
  register(
    "dohc_archive_version",
    {
      description:
        "Archive a version, named by its name or id from dohc_list_versions, or restore it with restore: true. An archived version keeps its files, leaves the version menu, and can't be switched to or merged until restored. Main, the active version, and versions with open conflicts can't be archived. Owner workspace only.",
      inputSchema: { version: z.string().min(1).max(200), restore: z.boolean().optional() },
      annotations: CHANGE,
    },
    async (args) => text(await archiveVersion(ctx, args)),
  );
  register(
    "dohc_resolve_version_conflict",
    {
      description:
        "Resolve an open conflict from dohc_list_version_conflicts. keep current or incoming keeps that side; keep combined with text replaces both. In a merge, current is Main and incoming is the version; in an update, current is the version and incoming is Main; in sync, current is this computer. A binary conflict takes no combined text. Returns the open conflicts that remain. Owner workspace only.",
      inputSchema: { conflictId: z.string().min(1).max(200), resolution: versionResolutionSchema },
      annotations: CHANGE,
    },
    async (args) => text(await resolveVersionConflict(ctx, args)),
  );

  // Cloud sync is automatic per workspace via the sync relay. Use
  // dohc_list_changes for workspace history and dohc_workspace_status to see
  // whether a workspace is cloud-synced.
  register(
    "dohc_list_changes",
    {
      description:
        "List workspace history, newest first: workspace-engine moments (the recorder for this workspace). Each entry carries path/operation/versionId. Pass path, relative to the MCP server folder, to list only that file's changes across its renames.",
      inputSchema: {
        sinceMs: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(500).optional(),
        includeFiles: z.boolean().optional(),
        path: z.string().min(1).max(4096).optional(),
      },
      annotations: READ,
    },
    async (args) => text(await listChanges(ctx, args)),
  );

  register(
    "dohc_list_notices",
    {
      description:
        "List the Notices rows for this workspace, newest first. Each row has its title, text, sender, time, whether it is read, and where it opens (`opens`): a file or folder path, a chat thread and message to read with dohc_read_chat, or an automation. A row with nowhere to go has `opens: null`, and `note` says why when dohc knows. Listing does not change whether rows are read.",
      inputSchema: {},
      annotations: READ,
    },
    async () => text(await listNotices(ctx)),
  );

  register(
    "dohc_list_kept_copies",
    {
      description:
        "List retained copies with a known workspace path, including copies adopted from staging during startup. Each entry names the file (`path`) that has a second copy, hidden until dohc_save_kept_copy moves it beside the file. `more` is true when the workspace kept more than this list holds.\n\nKnown copies deleted during replacement do not appear. Adopted staging files without an original path remain in `.dohc/engine/displaced`. Notices offers a recovery-folder action for these files; `watcher.status.keptFiles` also lists them. Copies kept from outside writes are ordinary workspace files listed separately in `outsideWriteCopies` in this tool's response as [original path, copy path, copy id] entries. Open the copy by its workspace path. Changes to protected files such as `.env` that a sync replaced or deleted are listed in `protectedCopies` as [path, id, keptAtMs] entries, kept on this computer only; use dohc_restore_protected_copy or dohc_discard_protected_copy.",
      inputSchema: {},
      annotations: READ,
    },
    async () => text(await listKeptCopies(ctx)),
  );

  register(
    "dohc_save_kept_copy",
    {
      description:
        "Move one kept copy from dohc_list_kept_copies to a visible file beside its file, such as `notes (kept copy).md`. The original file does not change. `status` is `saved` with the copy's `path`: read both, keep what you need, and delete the copy when you are done. `gone` means nothing is kept under that id any more. `no-valid-name` means no name beside the file fits dohc's path limits, so the copy stays kept: rename the file or its folder to something shorter and try again.",
      inputSchema: { id: z.number().int() },
      annotations: ADD,
    },
    async (args) => text(await saveKeptCopy(ctx, args)),
  );

  register(
    "dohc_discard_protected_copy",
    {
      description:
        "Remove one entry from `protectedCopies` in dohc_list_kept_copies for good. The kept change was never in History, so it cannot be brought back. The protected file does not change. `status` is `discarded` with the file's `path`.",
      inputSchema: { id: z.string() },
      annotations: CHANGE,
    },
    async (args) => text(await discardProtectedCopy(ctx, args)),
  );

  register(
    "dohc_save_recovery_copy",
    {
      description:
        "Save a live document's kept edits next to the document. Kept edits are edits the server refused, which dohc keeps on this computer, or on the server for a document it hosts (`storedOn`); dohc_workspace_status lists them as `keptEdits`. dohc writes a readable Markdown copy next to the document when it can read the edits as a document; `copyPath` is null when it cannot. Kept edits the note has no place for, such as text typed into a part someone else deleted, are listed at the end of the copy, and `notInNote` counts them. dohc also keeps a recovery package with every kept edit on this computer, at `packagePath` in .dohc/local/live-recovery, which does not sync. dohc writes these files itself, not as the agent that asked. For edits the server keeps, dohc then tells the server the copy is saved, and the `recovery` becomes `copied`. `keptEdits` is `kept` when the edits stay where `storedOn` says, `copied` when the server may now release them, and `ended` for edits a Stop could not write: dohc no longer keeps those, and the copy holds them, or the package when `copyPath` is null. Accepts every `recovery`. Pass the `incident` from `keptEdits` to save exactly those kept edits; without it, dohc saves edits a Stop could not write first. Owner workspace only.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        incident: z.string().min(1).max(1024).optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await saveRecoveryCopy(ctx, args)),
  );

  register(
    "dohc_retry_kept_edits",
    {
      description:
        "Send a live document's kept edits to the server once more, as Try again does in dohc. Take `path` and `incident` from `keptEdits` in dohc_workspace_status. Accepts a `recovery` of `paused`, or `copied` for edits the server keeps. When saveOnly is true, save a recovery copy instead. If recovery is unreadable, retry reads the edits again. Then read dohc_workspace_status: `retrying` until the server answers, `paused` with a new `incident` if it refuses again. A `not-written` or `stopping` document needs dohc_stop_again instead. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096), incident: z.string().min(1).max(1024) },
      annotations: CHANGE,
    },
    async (args) => text(await retryKeptEdits(ctx, args)),
  );

  register(
    "dohc_stop_again",
    {
      description:
        "Stop live editing again for a document whose Stop kept its edits, as Try again does on its row in dohc. Take `path` and `incident` from `keptEdits` in dohc_workspace_status. Accepts a `recovery` of `not-written`, where dohc writes the kept edits into the file, or `stopping`, where it asks the server again to stop live editing. `keptEdits` is `recovered` once the file holds the edits, `kept` while dohc still keeps them, and `none` when it kept none. dohc refuses while the document is open in an editor. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096), incident: z.string().min(1).max(1024) },
      annotations: CHANGE,
    },
    async (args) => text(await stopAgain(ctx, args)),
  );

  register(
    "dohc_keep_outside_change",
    {
      description:
        "Keep a live note's outside change, as Keep a copy does in dohc. Take `path` from dohc_list_outside_changes. dohc saves the file's bytes beside it as a copy, then writes the note's last saved text back into the file. `kept` is false when the file no longer holds an outside change. Owner workspace only.",
      inputSchema: { path: z.string().min(1).max(4096) },
      annotations: CHANGE,
    },
    async (args) => text(await keepOutsideChange(ctx, args)),
  );

  register(
    "dohc_list_live_documents",
    {
      description:
        "List this workspace's live documents, as Live documents shows them in dohc. Each row has `path`, `objectId`, `status` (`ready`, `preparing`, `paused`, `unavailable`, or `retired` once live editing stopped), `reason` when it is not live, and `canResume`, true when dohc_resume_live_editing can start it again. " +
        Object.entries(LIVE_DOCUMENT_REASON_STEPS)
          .map(([reason, step]) => `\`${reason}\`: ${step}`)
          .join(" ") +
        " `failure` `{ word, since }` is the server's word for why a row isn't live and when that began, as on `live-start-failing` rows." +
        " `record` is the server's record of the note: `state` (`off`, `starting`, `live`, or `stopping`), `reason` and `cause` for an off note, `generation`, `since`, and `changedBy`. `movedTo` is the path a note moved to; once stopped, pass `movedTo` to dohc_resume_live_editing to resume directly at that path." +
        " `deferredStop` `{ unsentEdits, editable }` is a Stop that waits for unsent edits. `quarantine` is the `recovery` of edits the server refused, with `storedOn` and `incident` as in `keptEdits`; `stopping` means a Stop waits for the server. Pass `nextCursor` as `cursor` until it is null. Owner workspace only.",
      inputSchema: { cursor: z.string().min(1).max(4096).optional() },
      annotations: READ,
    },
    async (args) => text(await listLiveDocuments(ctx, args)),
  );

  register(
    "dohc_stop_live_editing",
    {
      description:
        "Stop live editing for a document, as Stop does in Live documents. dohc_resume_live_editing starts it again. dohc records the Stop as this agent's when the server says this request stopped it; `already: true` means live editing was already stopped, and dohc records no one. Pass the row's `objectId` from dohc_list_live_documents to stop the server's document when its file moved or is gone; dohc then stops that document, whatever path it has now. `keptEdits` is `recovered` when dohc wrote edits the server refused into the file, `kept` while dohc still keeps them (see `keptEdits` in dohc_workspace_status), and `none` when there were none. Unlike Stop in Live documents, dohc refuses while the document is open in an editor, where someone may be typing; ask the person using dohc to close it. Owner workspace only.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        objectId: z.string().min(1).max(512).optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await stopLiveEditing(ctx, args)),
  );

  register(
    "dohc_list_retained_copies",
    {
      description:
        "List old file copies dohc keeps on a drive that cannot tell it whether another program still has one open, such as a macFUSE volume. dohc never deletes these itself. `total` counts them all, with their logical size in `bytes`; deleting them may free less disk space. `copies` lists those dohc_delete_retained_copies can delete now, oldest first, with the `revision` each delete must match. Copies changed in the last 30 seconds, copies whose file waits for review, and copies an unfinished save still needs are not listed. `more` is true when more copies remain past this list.",
      inputSchema: {},
      annotations: READ,
    },
    async () => text(await listRetainedCopies(ctx)),
  );

  register(
    "dohc_delete_retained_copies",
    {
      description:
        "Permanently delete up to 100 copies listed by dohc_list_retained_copies. They do not go to the trash. dohc cannot check whether another program still has one open: such a program may lose what it writes next. Ask the person to close other programs that use this workspace first, and set acceptLateWriteRisk to true. A copy that changed since it was listed, or whose file waits for review, is skipped and stays. Returns how many copies were `deleted`, `skipped` and `failed`, and the `remaining` count and bytes. List again to delete more.",
      inputSchema: {
        copies: z
          .array(z.strictObject({ id: z.number().int(), revision: z.number().int() }))
          .max(100),
        acceptLateWriteRisk: z.literal(true),
      },
      annotations: CHANGE,
    },
    async (args) => text(await deleteRetainedCopies(ctx, args)),
  );

  register(
    "dohc_read_change",
    {
      description:
        "Read one history entry by id: a workspace-engine moment with its full before/after payload.",
      inputSchema: {
        id: z.string().min(1).max(500),
      },
      annotations: READ,
    },
    async (args) => text(await readChange(ctx, args)),
  );

  register(
    "dohc_list_files",
    {
      description:
        "List visible files and folders in the workspace. Hidden dohc internals are omitted.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        recursive: z.boolean().optional(),
      },
      annotations: READ,
    },
    async (args) => text(await listWorkspaceFiles(ctx, args)),
  );

  register(
    "dohc_read_file",
    {
      description:
        "Read any visible workspace file as UTF-8 text or base64, returning size and sha256 for safe follow-up writes. A shared note's Markdown file can trail the note while its edits wait for the server, even when the result carries no warning; dohc_workspace_status lists those notes as pendingShare, and dohc_read_document returns their current text.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z
          .number()
          .int()
          .positive()
          .max(10 * 1024 * 1024)
          .optional(),
        offsetBytes: z.number().int().nonnegative().optional(),
      },
      annotations: READ,
    },
    async (args) => text(await readWorkspaceFile(ctx, args)),
  );

  register(
    "dohc_search_files",
    {
      description:
        "Search visible workspace file paths and text contents. Hidden dohc internals, .git, node_modules, symlinks, oversized files, and binary files are skipped.",
      inputSchema: {
        query: z.string().min(1).max(4096),
        path: z.string().max(4096).optional(),
        mode: z.enum(["content", "path", "both"]).optional(),
        caseSensitive: z.boolean().optional(),
        regex: z.boolean().optional(),
        maxResults: z.number().int().positive().max(1000).optional(),
        maxFileBytes: z
          .number()
          .int()
          .positive()
          .max(10 * 1024 * 1024)
          .optional(),
      },
      annotations: READ,
    },
    async (args) => text(await searchWorkspaceFiles(ctx, args)),
  );

  register(
    "dohc_read_document",
    {
      description:
        "Read a Markdown document as it is now, including edits an open editor has not saved to the file yet. Read it before dohc_edit_document: edits match this text.",
      inputSchema: {
        path: z.string().min(1).max(4096),
      },
      annotations: READ,
    },
    async (args) => text(await readDocument(ctx, args)),
  );

  register(
    "dohc_read_held_change",
    {
      description:
        "Read a change dohc held for a Markdown file because saving it would rewrite parts dohc can't show. `file` is the file's text on disk, or null; `held` is what saving the change would write. `change` is null when nothing is held. A change too large to return reports `tooLarge`. When dohc can't preview the change exactly, such as while edits wait to sync, it reports `unavailable` instead.",
      inputSchema: {
        path: z.string().min(1).max(4096),
      },
      annotations: READ,
    },
    async (args) => text(await readHeldChange(ctx, args)),
  );

  // The client names itself in the MCP handshake. A name the document door
  // accepts becomes the author of this agent's edits. The desktop labels unnamed agents "Agent".
  const agentName = (): string | undefined => {
    const named = documentAgentNameSchema.safeParse(server.server.getClientVersion()?.name);
    return named.success ? named.data : undefined;
  };
  // What the agent reports about itself on a chat write: its client's product
  // and version from the handshake, and the model it states. It travels
  // beside the author name and never changes it.
  const reported = (model: string | undefined) =>
    reportedAgent(server.server.getClientVersion(), model);

  register(
    "dohc_held_note_change",
    {
      description:
        "Review, drop, or undo a held note change. Only a local agent in the owner's workspace may use this. Review names the authors and returns a token. Drop requires that token, saves the waiting text in History, and returns an Undo token. Undo restores the waiting text as held. Neither action rewrites the file or grants conversion consent. Refusals: held-change-stale: Run review again and use its new token for drop. held-change-missing: Read the note again; there is no held change to drop. held-change-conflict: Resolve the conflict before reviewing and dropping again. held-change-undo-stale: Do not retry undo; recover the waiting text from History. held-change-shared-owner: Drop and undo are unavailable for adopted shared notes; leave the held work intact.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        action: z.enum(["review", "drop", "undo"]),
        token: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await heldNoteChange(ctx, args)),
  );

  register(
    "dohc_edit_document",
    {
      description:
        "Edit a Markdown document through dohc. A person editing it at the same time keeps their text and sees yours arrive. While someone may be typing in it, in an open editor or on a device it syncs to, an edit may change text inside blocks and add blocks, but not remove a block or change its kind. `find` is Markdown that occurs exactly once in the text dohc_read_document returns; it becomes `replacement`. Omit `find` to add `replacement` at the end. The edit changes the body, not the frontmatter. Pass `allowLossySourceSha256` (from dohc_read_file) only when confirming a rewrite of a lossy Markdown note that dohc cannot round-trip verbatim. It returns when the edit is saved. A pending `warning` means the edit is saved locally and the shared file update is pending; do not repeat the edit. Other warnings mean someone may be changing the same blocks; read the document to check. `requestId` is a random key you choose, such as a UUID. Sent again with the same key, after a timeout for example, the edit returns its first result instead of applying twice, while it runs and until 1,024 later keyed requests to this workspace have finished. dohc then refuses the key until 16,384 more have finished; after that, or after dohc restarts, the key can apply the edit again. Use a new key for each new edit, including one that redoes text a failed edit reported missing. If the call fails without a reason, read the document before you retry.",
      inputSchema: {
        allowLossySourceSha256: z
          .string()
          .regex(/^[0-9a-f]{64}$/u)
          .optional(),
        path: z.string().min(1).max(4096),
        find: documentEditTextSchema.min(1).optional(),
        replacement: documentEditTextSchema,
        requestId: requestIdSchema.optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await editDocument(ctx, args, agentName())),
  );

  register(
    "dohc_create_document",
    {
      description:
        "Create a Markdown document at a path that does not exist yet. `markdown` is its body text, without frontmatter. dohc writes it the way a person types into a new file, so later changes go through dohc_edit_document.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        markdown: documentEditTextSchema.optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await createDocument(ctx, args, agentName())),
  );

  register(
    "dohc_write_file",
    {
      description:
        "Write an ordinary workspace file. Markdown documents are created with dohc_create_document and changed with dohc_edit_document, and .excalidraw drawings with dohc_create_drawing and dohc_edit_drawing; this tool refuses both. Requires dohc open. History records the write under your agent name. Refuses secret or excluded paths and content over 10 MiB.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        expectedSha256: z.string().length(64).optional(),
        summary: z.string().max(500).optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await writeWorkspaceFile(ctx, args, agentName())),
  );

  register(
    "dohc_create_directory",
    {
      description:
        "Create a visible workspace directory. Files later written inside it are captured as engine moments by the desktop watcher.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        summary: z.string().max(500).optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await createWorkspaceDirectory(ctx, args)),
  );

  register(
    "dohc_move_path",
    {
      description:
        "Move or rename a visible workspace file or folder. Returns operationId and undo availability. Use dohc_undo_operation when available. Overwrites, moves that change only letter case, and files without History rows update no links. A folder move updates no links. Other file moves update [[links]] after the result returns. dohc_read_operation lists the documents it could not update. Requires dohc open. History records the move under your agent name. Refuses links, and secret, excluded, or reserved paths, including any inside a folder. Files over 5 MiB binary or 10 MiB text move without a History row. Text with invalid UTF-8 also moves without a row when History cannot keep it as binary. `withoutHistory` lists their destination paths. With overwrite, `replaced` separately reports the old destination's trash location and files without History copies. A failed move puts everything back it can. `deleted` lists files History records as deleted after rollback. They stay in the workspace's .dohc/local/trash, and Restore in History brings them back. In a version other than Main, refuses to change files the version does not track, such as files over those sizes, because they have one copy for every version and the change also happens in Main. Set confirmNotVersioned to true to change them anyway.",
      inputSchema: {
        fromPath: z.string().min(1).max(4096),
        toPath: z.string().min(1).max(4096),
        overwrite: z.boolean().optional(),
        confirmNotVersioned: z.boolean().optional(),
        summary: z.string().max(500).optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await moveWorkspacePath(ctx, args, agentName())),
  );

  register(
    "dohc_delete_path",
    {
      description:
        "Delete a visible workspace file or folder. Returns operationId and undo availability. Use dohc_undo_operation when available. Requires dohc open. History records the delete under your agent name, and Restore there brings the file back. Files over 5 MiB binary or 10 MiB text delete without a History row. Text with invalid UTF-8 also deletes without a row when History cannot keep it as binary. `withoutHistory` lists their paths. Restore these files from the trash. The file or folder goes through the workspace's .dohc/local/trash to the system trash, or stays in .dohc/local/trash when the system refuses; `trashed` says which. Refuses links, and secret, excluded, or reserved paths, including any inside a folder. If History refuses a file in a folder, `deleted` lists the files already deleted, and the rest go back to their place. In a version other than Main, refuses to change files the version does not track, such as files over those sizes, because they have one copy for every version and the change also happens in Main. Set confirmNotVersioned to true to change them anyway.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        confirmNotVersioned: z.boolean().optional(),
        summary: z.string().max(500).optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await deleteWorkspacePath(ctx, args, agentName())),
  );

  register(
    "dohc_detect_apps",
    {
      description:
        "Detect app folders in the workspace: web content a browser can open, found from index.html, package.json, dohc.json, and common web configs.",
      inputSchema: {
        path: z.string().max(4096).optional(),
        maxDepth: z.number().int().nonnegative().max(12).optional(),
      },
      annotations: READ,
    },
    async (args) => text(await detectApps(ctx, args)),
  );

  register(
    "dohc_create_app",
    {
      description:
        "Scaffold an app folder with app.publish.json and src/App.tsx, which use React and dohc/ui from the built-in app kit. Requires dohc open. History records each file under your agent name. A partial failure lists the files already written.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
        title: z.string().max(200).optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await createApp(ctx, args, agentName())),
  );

  register(
    "dohc_test_app",
    {
      description:
        "Check an app folder without running it: detector diagnostics and entry presence. In a workspace you own, dohc_publish_app action verifyFrontend compiles and runs the app in dohc's sandbox.",
      inputSchema: {
        appRoot: z.string().min(1).max(4096),
      },
      annotations: READ,
    },
    async (args) => text(await testApp(ctx, args)),
  );

  register(
    "dohc_import_data",
    {
      description:
        "Import a CSV/JSON/JSONL/Markdown source into a new visible .sqlite database. Requires dohc open and records the write under your agent name.",
      inputSchema: {
        sourcePath: z.string().min(1).max(4096),
        databasePath: z.string().min(1).max(4096),
        tableName: z.string().min(1).max(256),
      },
      annotations: ADD,
    },
    async (args) => text(await importData(ctx, args, agentName())),
  );

  register(
    "dohc_query_database",
    {
      description:
        "Run a single read-only SELECT against a visible workspace database (bounded rows).",
      inputSchema: {
        databasePath: z.string().min(1).max(4096),
        sql: z
          .string()
          .min(1)
          .max(64 * 1024),
      },
      annotations: READ,
    },
    async (args) => text(await queryDatabase(ctx, args)),
  );

  register(
    "dohc_list_file_chats",
    {
      description:
        "List the dohc Chats linked to a workspace file. Chats follow the file's stable dohc identity across renames. Requires the workspace engine.",
      inputSchema: {
        path: z.string().min(1).max(4096),
      },
      annotations: READ_SERVER,
    },
    async (args) => text(await listFileChats(ctx, args)),
  );

  register(
    "dohc_wait_for_messages",
    {
      description:
        "Wait for this agent's unread requests without marking them read. In a run dohc started, they are the run's own requests, including replies in threads its agent posted in, and the ones it returns start no new run. With --agent-id, they are that agent's: its direct messages, messages that @ its name, and replies in threads it posted in. Otherwise, they are @agent mentions and replies in threads an agent with no id posted in. Returns messages and a cursor, or an empty batch after at most 25 seconds. Call in a loop with the returned cursor and the same filters. Group and thread filters only narrow the inbox. At most 4 waits can run on this connection.",
      inputSchema: chatWatchInputSchema.shape,
      annotations: ADD_SERVER,
    },
    async (args, extra) => {
      if (waits >= 4)
        return text({
          ok: false,
          reason: "Too many chat waits. Finish an existing wait and try again.",
        });
      waits += 1;
      try {
        return text(await waitForMessages(ctx, args, extra.signal));
      } finally {
        waits -= 1;
      }
    },
  );

  register(
    "dohc_link",
    {
      description:
        "Make a link to a chat, thread, message, file, app, or Collection. Pass exactly one of `group` (a Group, DM, or agent chat, by name, #slug, or id), `thread`, `message` (ids), or `path` (a file, or an app or a Collection by its folder). Put the returned `link` text, `@[work:...]`, in a chat message: it shows as a chip that opens what it names, and keeps working after a rename or move.",
      inputSchema: {
        group: z.string().min(1).max(500).optional(),
        thread: z.string().min(1).max(200).optional(),
        message: z.string().min(1).max(200).optional(),
        path: z.string().min(1).max(4096).optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await makeLink(ctx, args)),
  );

  register(
    "dohc_read_chat",
    {
      description:
        "Read one dohc Chat thread, or one group's stream. With `threadId`: its messages (with author kind, display name, and the product, version, and model an agent reported, in `authorReported`), whether agent replies are paused and the latest run outcome, and a read-only text projection. With `group` (a name, #slug, or id): its posts and conversation messages in one order, oldest first, a page at a time from the newest end. Each post says how many replies it has, who replied, and the latest agent reply. A message an agent reported work with has `work`, and a post whose thread has such a report has its Work card in `post.work`. Pass `nextBefore` back as `before` for the older page; `limit` is 50 by default, at most 100. Messages name the agents still asked to answer them in `agentRequests`.",
      inputSchema: {
        threadId: z.string().min(1).max(200).optional(),
        group: z.string().min(1).max(500).optional(),
        before: z
          .object({
            createdAtMs: z.number().int().nonnegative(),
            lane: z.enum(["posts", "chat"]),
            id: z.string().min(1).max(200),
          })
          .strict()
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: READ_SERVER,
    },
    async (args) => text(await readChat(ctx, args)),
  );

  register(
    "dohc_list_groups",
    {
      description:
        "List the workspace's Chats groups (including the default #general) with each group's chats and their ids. It also returns direct messages and the agent lane, told apart by `kind`. Requires the workspace engine.",
      inputSchema: {},
      annotations: ADD_SERVER,
    },
    async () => text(await listGroups(ctx)),
  );

  register(
    "dohc_create_group",
    {
      description:
        "Create a Chats group and its folder, as New group does. `name` is the group's name, 1 to 80 characters with a letter or number; its folder is the name as a slug. `purpose` says what the group is for. `type` is posts, chat, or both, the default. `level` sets what members can do in it as it is made: comment lets them post, view lets them read, none hides it from them. A group made with a level has no folder, and needs a connection. A name already taken is refused; find that group with dohc_list_groups. Returns the group's id, name, slug, and kind for dohc_start_group_chat.",
      inputSchema: {
        name: z.string().min(1).max(80),
        purpose: z.string().max(200).optional(),
        type: z.enum(["posts", "chat", "both"]).optional(),
        level: z.enum(["comment", "view", "none"]).optional(),
      },
      annotations: ADD_SERVER,
    },
    async (args) => text(await createGroup(ctx, args)),
  );

  const chatWriteInput = {
    // The desktop validates normalized UTF-8 bytes before any chat write.
    body: z.string().min(1),
    attachments: z.array(z.string().min(1).max(4096)).max(32).optional(),
    needsDecision: z.boolean().optional(),
    options: z
      .array(
        z.union([
          z.string().min(1).max(200),
          z
            .object({ label: z.string().min(1).max(200), detail: z.string().max(300).optional() })
            .strict(),
        ]),
      )
      .max(12)
      .optional(),
    runId: z.string().min(1).max(200).optional(),
    model: reportedAgentPartSchema.optional(),
    work: chatWorkReportSchema.optional(),
  };

  register(
    "dohc_start_group_chat",
    {
      description:
        "Start a new chat in a group as the agent. `group` accepts a group name, #slug, or id. No title needed; the chat displays its first message. `attachments` name tracked files relative to the MCP server folder; `needsDecision` asks for a decision and `options` turns it into a poll: give each choice as a short label, or as `{ label, detail }` with a one-line explanation, and keep the choices out of `body` so people read them once; `runId` links the message to a local agent run. `model` names the model you run as, such as Claude Opus 5.5; people see it marked as reported, beside the product and version your MCP client reports. Leave it out if you don't know. `work` reports work you do outside dohc, such as a thread in another product or a pull request: `status` is working, waiting, done, failed, or stopped, and `url` is an http or https link to the work, in plain ASCII with other characters percent-encoded. The chat then shows a Work card with the status and link of its newest report, marked as reported. Reply with `work` again to change it, and give `url` again to keep the link. Returns engine ids usable with dohc_read_chat.",
      inputSchema: {
        group: z.string().min(1).max(200),
        title: z.string().min(1).max(200).optional(),
        ...chatWriteInput,
      },
      annotations: ADD_SERVER,
    },
    async ({ model, ...args }) =>
      text(await startGroupChat(ctx, args, agentName(), reported(model))),
  );

  register(
    "dohc_start_file_chat",
    {
      description:
        "Comment on a workspace file as the agent. This starts a chat linked to the file, as a person does from the file's Chats panel: `title` names the chat there and `body` is its first message. dohc_list_file_chats returns it, and dohc_reply_to_chat continues it. `requestId` is a random key you choose, such as a UUID. Sent again with the same key, after a timeout for example, the comment returns its first result instead of starting a second chat, while it runs and until 1,024 later keyed requests to this workspace have finished. dohc then refuses the key until 16,384 more have finished; after that, or after dohc restarts, the key can start another chat. `runId` and `model` behave as in dohc_start_group_chat. To comment on a passage of a Markdown file, start `body` with a Markdown quote of the passage (`> the passage`), then a blank line, then the comment: the file's editor highlights that passage and opens the comment from it.",
      inputSchema: {
        path: z.string().min(1).max(4096),
        title: z.string().min(1).max(200),
        body: chatWriteInput.body,
        requestId: requestIdSchema.optional(),
        runId: chatWriteInput.runId,
        model: chatWriteInput.model,
      },
      annotations: ADD_SERVER,
    },
    async ({ model, ...args }) =>
      text(await startFileChat(ctx, args, agentName(), reported(model))),
  );

  register(
    "dohc_reply_to_chat",
    {
      description:
        "Reply in a dohc Chat thread as the agent. `to` replies under one message; `resolve` closes that open decision with this reply and `choose` names the option picked. Message ids come from dohc_read_chat. `attachments`, `needsDecision`, `options`, `runId`, `model`, and `work` behave as in dohc_start_group_chat. A run an automation started that has nothing to report sends `nothingToReport: true` with only `threadId` and `runId`, and no `body`: it posts nothing, and the run ends without a failure.",
      inputSchema: {
        threadId: z.string().min(1).max(200),
        to: z.string().min(1).max(200).optional(),
        resolve: z.string().min(1).max(200).optional(),
        choose: z.string().min(1).max(200).optional(),
        ...chatWriteInput,
        body: chatWriteInput.body.optional(),
        nothingToReport: z.literal(true).optional(),
      },
      annotations: CHANGE_SERVER,
    },
    async ({ model, body, nothingToReport, ...args }) => {
      if (nothingToReport) {
        // An empty list or a false flag sends nothing.
        const { threadId, runId, ...message } = args;
        const sent = Object.values(message).some(
          (value) =>
            value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0),
        );
        return text(
          body !== undefined || sent
            ? {
                ok: false as const,
                reason: "nothingToReport posts no message. Send it with only threadId and runId.",
              }
            : await reportNothing(ctx, { threadId, ...(runId !== undefined ? { runId } : {}) }),
        );
      }
      if (body === undefined)
        return text({
          ok: false as const,
          reason: "Send a body, or nothingToReport to end an automation's run with no message.",
        });
      return text(await replyToChat(ctx, { ...args, body }, agentName(), reported(model)));
    },
  );

  register(
    "dohc_query_collection",
    {
      description:
        "Query a collection folder's indexed records: filter, sort, group, and page. Requires the workspace engine and the dohc app.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        filter: z
          .strictObject({
            field: z.string().min(1).max(200),
            operator: z.enum(["equals", "contains"]),
            value: z.unknown(),
          })
          .optional(),
        sort: z
          .array(
            z.strictObject({
              field: z.string().min(1).max(200),
              direction: z.enum(["asc", "desc"]),
            }),
          )
          .max(8)
          .optional(),
        groupBy: z.string().min(1).max(200).optional(),
        resolveRelations: z.boolean().optional(),
        limit: z.number().int().positive().max(500).optional(),
        cursor: z.unknown().optional(),
      },
      annotations: READ,
    },
    async (args) => text(await queryCollection(ctx, args)),
  );

  register(
    "dohc_read_record",
    {
      description:
        "Read one collection record by id: current field values plus per-field history with author attribution. Requires the workspace engine and the dohc app.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        recordId: z.string().min(1).max(200),
        historyLimit: z.number().int().positive().max(500).optional(),
        beforeHistoryId: z.number().int().nonnegative().optional(),
      },
      annotations: READ,
    },
    async (args) => text(await readRecord(ctx, args)),
  );

  register(
    "dohc_set_record_fields",
    {
      description:
        'Set fields on a collection record as the agent, e.g. fields: {"status": "done"}. The change lands in the record\'s live frontmatter, open desktop views update, and record history attributes it to the agent.',
      inputSchema: {
        recordPath: z.string().min(1).max(4096),
        fields: z.record(z.string().min(1).max(200), z.unknown()),
      },
      annotations: CHANGE,
    },
    async (args) => text(await setRecordFields(ctx, args, agentName())),
  );

  register(
    "dohc_create_record",
    {
      description:
        "Create a Markdown record in a collection folder as the agent, optionally seeding fields, and return its record id. The kept map reports current values of seed fields preserved after someone edited them. On partial creation, retry with partial.retry.recordId and the same inputs to finish the existing record. Other taken names are refused.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        name: z.string().min(1).max(200),
        recordId: z
          .string()
          .regex(/^rec_[a-z2-7]{26}$/)
          .optional(),
        fields: z.record(z.string().min(1).max(200), z.unknown()).optional(),
      },
      annotations: ADD,
    },
    async (args) => text(await createRecord(ctx, args, agentName())),
  );

  const automationInput = {
    collectionPath: z.string().min(1).max(4096),
    automation: z.string().min(1).max(200),
  };

  register(
    "dohc_list_automation_runs",
    {
      description:
        "List an automation's runs on this computer, 20 at a time, newest first: each run's id, state, what started it, how many changes it made, and why it failed. Name the automation by its Collection's folder and its id in automations.yaml. When older runs remain, `next` is not null; pass it as `page` to list them. Each computer keeps the runs of the automations it ran for 30 days after they end. With server true, list the runs of the workspace's self-hosted server instead. A run marked unsentChangesLost ran in a copy the server lost, and its latest changes may not have been sent.",
      inputSchema: {
        ...automationInput,
        page: z.string().min(1).max(512).optional(),
        server: z.boolean().optional(),
      },
      annotations: READ_SERVER,
    },
    async (args) => text(await listAutomationRuns(ctx, args)),
  );

  register(
    "dohc_read_automation_run",
    {
      description:
        "Read one automation run: what started it, what each step changed, why it failed, which step failed, and whether Try again resumes there or starts over. Steps count from 1 in the order automations.yaml lists them, including the steps inside if and otherwise. A step that changed nothing is not listed. With server true, read a run of the workspace's self-hosted server: it lists what the run changed, oldest first, as `changes` instead of steps.",
      inputSchema: {
        ...automationInput,
        run: z.string().min(1).max(256),
        server: z.boolean().optional(),
      },
      annotations: READ_SERVER,
    },
    async (args) => text(await readAutomationRun(ctx, args)),
  );

  register(
    "dohc_retry_automation_run",
    {
      description:
        "Try a failed automation run again, as Try again does in dohc. It resumes after the last step that finished. If the automation changed since the run failed, it refuses unless startOver is true, which runs it from the first step and can repeat changes the run already made. Only the computer that ran it can try a run again; anywhere else the refusal names that computer.",
      inputSchema: {
        ...automationInput,
        run: z.string().min(1).max(256),
        startOver: z.boolean().optional(),
      },
      annotations: CHANGE,
    },
    async (args) => text(await retryAutomationRun(ctx, args)),
  );

  register(
    "dohc_press_button",
    {
      description:
        "Press a Button field on one record, as a person clicks it in dohc, and get the id of the run it started; follow it with dohc_read_automation_run. Name the record by its id, or a dataset record by its primary key as JSON. A press that would run actions dohc cannot undo is refused with each action's name; press again with those names in confirm to run them. Send the same requestId again, after a timeout for example, to get the same press instead of a second one. The press is recorded as the agent's, for the person; from an agent run that an automation started, it counts in that chain of automations, which stops after 4 steps.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        button: z.string().min(1).max(256),
        recordId: z.string().min(1).max(1024),
        table: z.string().min(1).max(256).optional(),
        confirm: z.array(z.string().min(1).max(256)).max(64).optional(),
        requestId: requestIdSchema.optional(),
      },
      annotations: CHANGE_SERVER,
    },
    async (args) => text(await pressButton(ctx, args)),
  );

  register(
    "dohc_inspect_buttons",
    {
      description:
        "Inspect a Collection's Button fields, their current access, and any actions that need confirmation. Shared Collection buttons are checked on the owner's host.",
      inputSchema: {
        collectionPath: z.string().min(1).max(4096),
        table: z.string().min(1).max(256).optional(),
      },
      annotations: READ_SERVER,
    },
    async (args) => text(await inspectButtons(ctx, args)),
  );

  return server;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${MCP_USAGE}\n`);
    return;
  }
  const ctx = parseArgs(argv);
  const server = createDohcMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

// Run only when invoked as the entry binary, not when imported by tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
