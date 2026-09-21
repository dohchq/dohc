import { expect, test, type Page } from "@playwright/test";
import { sendCliRequest } from "@dohc/cli/client";
import { CLI_PROTOCOL_VERSION, type CliRequestWithoutToken, type CliResultByVerb, type CliVerb } from "@dohc/cli/protocol";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchDesktopApp } from "./helpers/desktopApp";
import {
  cleanupDesktopWorkspace,
  createTempWorkspace,
  openWorkspaceFromFirstRun,
  seedWorkspaceManifest,
  type TempWorkspace,
} from "./helpers/workspace";

// The Phase 3 agent walkthrough gate: an agent
// creates a collection and records by ordinary file writes, sets fields and
// creates a record through its MCP tools, and queries the result — while an
// open desktop view reflects every step live, and record history attributes
// each change to the agent.
//
// The agent here is this spec's own process. Its collection tools cross the
// desktop's authenticated CLI socket — the exact hop `packages/mcp` sends
// (`requestCli` in packages/mcp/src/tools.ts builds the same request with
// `cwd` and `actor: "agent"`); the MCP registration and path-containment
// layer above that hop is pinned by the @dohc/mcp unit suites.

type Desktop = Awaited<ReturnType<typeof launchDesktopApp>>;

// Valid record ids (rec_ + 26 chars of a-z2-7) seeded in the files so the
// engine adopts the spelled identity instead of minting one per run.
const APOLLO_ID = "rec_apolloe2e234567abcdefgh234";
const ZEPHYR_ID = "rec_zephyre2e234567abcdefgh234";

const SCHEMA_YAML = [
  "name: tasks",
  "fields:",
  "  Name:",
  "    type: text",
  "  Status:",
  "    type: select",
  "    options:",
  "      - Todo",
  "      - Doing",
  "views:",
  "  - name: Board",
  "    kind: board",
  "    groupBy: Status",
  "",
].join("\n");

function recordMd(id: string, name: string, status: string): string {
  return `---\nid: ${id}\nName: ${name}\nStatus: ${status}\n---\n`;
}

// One agent-side collection call over the desktop CLI socket. The state dir
// holds the app's per-boot endpoint and token (the chats-feed spec's CLI
// discovery, driven through the client library instead of the binary).
async function agentCli<Verb extends CliVerb>(
  temp: TempWorkspace,
  verb: Verb,
  args: Omit<Extract<CliRequestWithoutToken, { verb: Verb }>["args"], "cwd" | "actor">,
): Promise<CliResultByVerb[Verb]> {
  const request = {
    protocolVersion: CLI_PROTOCOL_VERSION,
    verb,
    args: { cwd: temp.rootPath, actor: "agent" as const, ...args },
  } as unknown as Extract<CliRequestWithoutToken, { verb: Verb }>;
  return await sendCliRequest<Verb>(request, { stateDir: temp.homeDir });
}

async function waitForCliEndpoint(homeDir: string): Promise<void> {
  const endpointFile = process.platform === "win32"
    ? "dohc-cli-endpoint"
    : "dohc-cli.sock";
  await expect
    .poll(
      async () => {
        try {
          await Promise.all([
            access(join(homeDir, endpointFile)),
            access(join(homeDir, "dohc-cli-token")),
          ]);
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 10_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
}

// The agent's collection lands as a live view: the tree row carries
// data-collection once the engine adopts the folder, and one click opens it.
async function openCollectionFromTree(page: Page): Promise<void> {
  const tasksRow = page.locator('[data-testid="tree-row"][data-path="tasks"]');
  await expect(tasksRow).toHaveAttribute("data-collection", "true", {
    timeout: 60_000,
  });
  await tasksRow.click();
  await expect(page.getByTestId("collection-page")).toBeVisible({
    timeout: 30_000,
  });
}

function boardCard(page: Page, column: string, title: string) {
  return page.locator(
    `section[aria-label="${column}"] [role="listitem"][aria-label="${title}"]`,
  );
}

test("an agent's file-written collection opens live and answers its MCP queries", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;

  try {
    await seedWorkspaceManifest(temp, "collections-agent-walkthrough-e2e");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    // --- The agent creates the collection with ordinary file writes: a
    // schema and one record. The open app's watcher captures them.
    await mkdir(join(temp.rootPath, "tasks"), { recursive: true });
    await writeFile(join(temp.rootPath, "tasks", "collection.yaml"), SCHEMA_YAML);
    await writeFile(
      join(temp.rootPath, "tasks", "apollo.md"),
      recordMd(APOLLO_ID, "Apollo", "Todo"),
    );
    await openCollectionFromTree(page);
    await expect(boardCard(page, "Todo", "Apollo")).toBeVisible({
      timeout: 30_000,
    });

    // --- A second record written while the board is open appears live: no
    // refresh, no UI action.
    await writeFile(
      join(temp.rootPath, "tasks", "zephyr.md"),
      recordMd(ZEPHYR_ID, "Zephyr", "Doing"),
    );
    await expect(boardCard(page, "Doing", "Zephyr")).toBeVisible({
      timeout: 30_000,
    });

    // --- The desktop offers this workspace's MCP config as the writable
    // local profile: no --share-access narrows the agent's tools here.
    const mcpArgs = await page.evaluate(async () => {
      const api = (window as unknown as {
        dohcDesktop: {
          getWorkspaceRegistry(): Promise<{
            workspaces: Array<{ workspaceId: string }>;
          }>;
          getMcpConfig(payload: { workspaceId: string }): Promise<{ args: string[] }>;
        };
      }).dohcDesktop;
      const registry = await api.getWorkspaceRegistry();
      const config = await api.getMcpConfig({
        workspaceId: registry.workspaces[0]!.workspaceId,
      });
      return config.args;
    });
    expect(mcpArgs).not.toContain("--share-access");

    // --- The agent queries its collection back through the CLI hop its MCP
    // tools use: both records, with the indexed field values.
    await waitForCliEndpoint(temp.homeDir);
    const query = await agentCli(temp, "collectionQuery", {
      collectionPath: "tasks",
    });
    if (!query.ok) throw new Error(`collectionQuery failed: ${query.reason}`);
    expect(query.records.map((entry) => entry.id).sort()).toEqual(
      [APOLLO_ID, ZEPHYR_ID].sort(),
    );
    const apollo = query.records.find((entry) => entry.id === APOLLO_ID);
    expect(apollo?.path).toBe("tasks/apollo.md");
    expect(
      apollo?.values.find((value) => value.field === "Status")?.value,
    ).toBe("Todo");

    // A filtered query narrows to the one Doing record.
    const filtered = await agentCli(temp, "collectionQuery", {
      collectionPath: "tasks",
      filter: { field: "Status", operator: "equals", value: "Doing" },
    });
    if (!filtered.ok) throw new Error(`filtered query failed: ${filtered.reason}`);
    expect(filtered.records.map((entry) => entry.id)).toEqual([ZEPHYR_ID]);

    // --- One record read returns the record plus its bounded history page.
    const detail = await agentCli(temp, "collectionRecord", {
      collectionPath: "tasks",
      recordId: APOLLO_ID,
      historyLimit: 50,
    });
    if (!detail.ok) throw new Error(`collectionRecord failed: ${detail.reason}`);
    expect(detail.record.id).toBe(APOLLO_ID);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});

// The write half of the gate: MCP field sets and record creates ride the
// desktop's one collection write seam, attributed to the agent.
test("an agent's MCP field set and record create land live with agent attribution", async () => {
  test.setTimeout(240_000);
  const temp = await createTempWorkspace();
  let desktop: Desktop | null = null;

  try {
    await seedWorkspaceManifest(temp, "collections-agent-writes-e2e");
    desktop = await launchDesktopApp({ workspace: temp });
    const page = desktop.page;
    await openWorkspaceFromFirstRun(page, temp);

    await mkdir(join(temp.rootPath, "tasks"), { recursive: true });
    await writeFile(join(temp.rootPath, "tasks", "collection.yaml"), SCHEMA_YAML);
    await writeFile(
      join(temp.rootPath, "tasks", "apollo.md"),
      recordMd(APOLLO_ID, "Apollo", "Todo"),
    );
    await openCollectionFromTree(page);
    await expect(boardCard(page, "Todo", "Apollo")).toBeVisible({
      timeout: 30_000,
    });
    await waitForCliEndpoint(temp.homeDir);

    // --- The agent sets a field through its MCP write tool: the card moves
    // columns on the open board with no refresh, and the write settles into
    // the record's file.
    const set = await agentCli(temp, "collectionSetFields", {
      recordPath: "tasks/apollo.md",
      fields: { Status: "Doing" },
    });
    if (!set.ok) throw new Error(`collectionSetFields failed: ${set.reason}`);
    expect(set.recordPath).toBe("tasks/apollo.md");
    await expect(boardCard(page, "Doing", "Apollo")).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(
        async () => {
          try {
            return /Status:\s*Doing/.test(
              await readFile(join(temp.rootPath, "tasks", "apollo.md"), "utf8"),
            );
          } catch {
            return false;
          }
        },
        { timeout: 30_000, intervals: [500] },
      )
      .toBe(true);

    // --- Record history attributes the change to the agent: the CLI hop's
    // derived author is agent `dohc-mcp`, and the engine stamps that origin
    // on the field's history row.
    const detail = await agentCli(temp, "collectionRecord", {
      collectionPath: "tasks",
      recordId: APOLLO_ID,
      historyLimit: 50,
    });
    if (!detail.ok) throw new Error(`collectionRecord failed: ${detail.reason}`);
    const statusChange = detail.history.find(
      (entry) => entry.field === "Status" && entry.next.value === "Doing",
    );
    expect(statusChange).toBeDefined();
    expect(statusChange?.authorOriginId).toBe("dohc-mcp");

    // --- The agent creates a record through MCP: the engine mints its id,
    // the open board shows the new card live, and a query returns both.
    const created = await agentCli(temp, "collectionCreateRecord", {
      collectionPath: "tasks",
      name: "hermes",
      fields: { Name: "Hermes", Status: "Todo" },
    });
    if (!created.ok) throw new Error(`collectionCreateRecord failed: ${created.reason}`);
    expect(created.recordPath).toBe("tasks/hermes.md");
    expect(created.recordId).toMatch(/^rec_[a-z2-7]{26}$/);
    await expect(boardCard(page, "Todo", "Hermes")).toBeVisible({
      timeout: 30_000,
    });
    const query = await agentCli(temp, "collectionQuery", {
      collectionPath: "tasks",
    });
    if (!query.ok) throw new Error(`collectionQuery failed: ${query.reason}`);
    expect(query.records.map((record) => record.path).sort()).toEqual([
      "tasks/apollo.md",
      "tasks/hermes.md",
    ]);
  } finally {
    await cleanupDesktopWorkspace(desktop, temp);
  }
});
